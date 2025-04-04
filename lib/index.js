
var pm2        = require('pm2');
var async      = require('async');
var pkg        = require('../package.json');
var FixedQueue = require('./fixedQueue');
var semver     = require('semver');

/**
 * Pm2 / Keymetrics probes
 */
var queue  = FixedQueue(20);

var pmx      = require('pmx');
var pmx_conf = pmx.initModule();
var Probe    = pmx.probe();

var inTotalMsg = Probe.counter({
  name : 'IN total'
});

var outTotalMsg = Probe.counter({
  name : 'OUT total'
});

var inMsgMetter = Probe.meter({
  name : 'IN msg/sec'
});

var outMsgMetter = Probe.meter({
  name : 'OUT msg/sec'
});

var procNb = Probe.metric({
  name  : 'processes',
  value : function() {
    return process_list.length;
  }
});

pmx.action('20 last msgs', function(reply) {
  reply(queue);
});

var process_list = [];
var t_retrieval = null;

/**
 * Broadcast strategies
 */
var Strategies = {
  broadcast : function(packet) {
    async.forEachLimit(process_list, 3, function(proc, next) {
      sendDataToProcessId(proc.pm_id, packet);
      next();
    }, function(err) {
      if (err) console.error(err);
    });
  },
  roundrobin : function(packet) {
    var proc = process_list[Math.floor(Math.random()*process_list.length)];
    sendDataToProcessId(proc.pm_id, packet);
  },
  toMaster : function(packet) {
    var proc = process_list.find(v => v.namespace === packet.process.namespace && v.master);
    sendDataToProcessId(proc.pm_id, packet);
  }
};

function sendDataToProcessId(proc_id, packet) {
  if (typeof(packet.raw) == 'undefined' ||
      typeof(packet.raw.data) === 'undefined' ||
      !packet.raw.topic) {
    return
  }

  outMsgMetter.mark();
  outTotalMsg.inc();
  pm2.sendDataToProcessId(proc_id, packet.raw, function(err, res) {
    if (err) console.error(err);
  });
};

/**
 * Strategy selection
 */
function intercom(bus) {
  bus.on('process:msg', function(packet) {
    inMsgMetter.mark();
    inTotalMsg.inc();
    queue.push(packet);
    switch (packet.raw.strategy) {
      case 'broadcast':
      Strategies.broadcast(packet);
      case 'roundrobin':
      Strategies.roundrobin(packet);
      default:
      Strategies.toMaster(packet);
    }
  });
}

/**
 * WORKER: Retrieve and format app
 */
function cacheApps() {
  function getProcList() {
    pm2.list(function(err, list) {
      if (err) {
        console.error(err);
        return;
      }
      process_list = list.map(function(proc) {
        return {
          name : proc.name,
          namespace : proc.pm2_env.namespace,
          master : proc.pm2_env.NODE_APP_INSTANCE === 0,
          pm_id : proc.pm_id
        };
      });
    });
  }

  getProcList();
  t_retrieval = setInterval(getProcList, 2000);
}

/**
 * Main entry
 */
pm2.connect(function(err) {
  if (err)
    throw new Error(err);

  // PM2 version checking
  pm2.getVersion(function(err, data) {
    if (semver.gte(data, "0.15.11") == false) {
      exit();
      throw new Error('This PM2 version is not compatible with %s!!', pkg.name);
    }
  });

  pm2.launchBus(function(err, bus) {
    if (err)
      throw new Error(err);

    console.log('[%s:%s] ready', pkg.name, pkg.version);

    cacheApps();
    intercom(bus);
  });
});

function exit() {
  pm2.disconnect();
  pm2.disconnectBus && pm2.disconnectBus();
  clearInterval(t_retrieval);
}
/**
 * When PM2 try to kill app
 */
process.on('SIGINT', function() {
  exit();
  setTimeout(function() {
    process.exit(0);
  }, 200);
});
