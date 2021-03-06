var redis = require("redis")
  , util = require("util")
  , events = require("events")
  , registrations = require('thalassa-registrations')
  , stats = require('./stats')
  ;

var RedisData = module.exports = function RedisData (opts) {
  events.EventEmitter.call(this);

  if (!opts) opts = {};  var self = this;
  this.log = (typeof opts.log === 'function') ? opts.log : noop;

  this.SECONDS_TO_EXPIRE = opts.secondsToExpire || 10;
  this.REGISTRATIONS_SET_KEY = '__thalassa.registrations';
  this.REDIS_HOST = opts.redisHost || '127.0.0.1';
  this.REDIS_PORT = opts.redisPort || 6379;
  this.REDIS_DB = opts.redisDatabase || 0;

  this.redisClient = redis.createClient(this.REDIS_PORT, this.REDIS_HOST);
  this.redisClient.select(this.REDIS_DB);
};

util.inherits(RedisData, events.EventEmitter);

/**
 * Update or create a registration
 *
 * @param {Registration} reg
 * @param {number} [secondsToExpire=opts.secondsToExpire]
 * @param {Function} cb - Callback cb(error)
 */

RedisData.prototype.update = function update(reg, secondsToExpire, cb) {
  var self = this;
  if (typeof secondsToExpire === 'function' && cb === undefined) {
    cb = secondsToExpire;
    secondsToExpire = self.SECONDS_TO_EXPIRE;
  }
  else if (!secondsToExpire) {
    secondsToExpire = self.SECONDS_TO_EXPIRE;
  }
  cb = callback(cb);

  stats.meter('registrationsPerSecond').mark();

  var registration = registrations.create(reg);

  var client = this.redisClient;
  var timeToExpire = Date.now() + ((secondsToExpire) * 1000);

  client.multi()
    //
    // set the registration details to a key by id
    // /name/version/host/port
    //
    .set(registration.id, registration.stringify())
    //
    // add the timeToExpire to the registrations sorted set
    //
    .zadd(self.REGISTRATIONS_SET_KEY, timeToExpire, registration.id, function (error, numNew) {
      //self.log('debug', 'RedisData.update ' + registration.id + ' ' + timeToExpire);
      self.emit('online', registration);
    })
    .exec(function (error, replies) {
      //self.log('debug', 'RedisData.update redis multi replies', replies);
      cb(error);
    });
};

/**
 * Explicitly delete a registration
 *
 * @param {String} regId
 * @param {Function} cb - Callback cb(error)
 */

RedisData.prototype.del = function del(regId, cb) {
  cb = callback(cb);
  var self = this;
  var client = this.redisClient;
  client.multi()
  .del(regId)
  .zrem(this.REGISTRATIONS_SET_KEY, regId)
  .exec(function (error, replies) {
    self.emit('offline', regId);
    cb(error);
  });
};

/**
 * Find all `Registration`s for `name` and `version` if provided.
 *
 * @param {String} [name]
 * @param {String} [version]
 * @param {getRegistrationsCallback} cb - Callback cb(error, registrations)
 *
 * @callback getRegistrationsCallback
 * @param {Error} error
 * @param {Registrations[]} registrations
 */

RedisData.prototype.getRegistrations = function getRegistrations(name, version, cb) {

/**
 */
  var keySearch;
  if (typeof name === 'function') {
    cb = name;
    keySearch = '/*';
  }
  else if (typeof version === 'function') {
    cb = version;
    keySearch = util.format('/%s/*', name);
  }
  else if (typeof cb === 'function') {
    keySearch = util.format('/%s/%s/*', name, version);
  }

  cb = callback(cb);
  this._getRegistrations(keySearch, cb);
};

/**
 * Find all `Registration`s for a `keySearch` prefix
 *
 * @api private
 * @param {String} keySearch - Redis `regId` key prefix to search for registrations
 * @param {_getRegistrationsCallback} cb - Callback cb(error, registrations)
 *
 * @callback _getRegistrationsCallback
 * @param {Error} error
 * @param {Registrations[]} registrations
 */

RedisData.prototype._getRegistrations = function _getRegistrations(keySearch, cb) {
  var self = this;
  var client = this.redisClient;

  client.keys(keySearch, function (error, ids) {
      if (error) return cb(error);

      if (!ids || ids.length === 0) return cb(null, []);
      var regIds = ids.filter(function (id) { return registrations.isRegistrationId(id); });
      if (regIds.length === 0) return cb(null, []);

      client.mget(ids, function (error, stringifiedRegs) {
        if (error) return cb(error);
        var regs = stringifiedRegs
              .map(function(stringifiedReg) { return registrations.parse(stringifiedReg); });
        cb(null, regs);
      });
  });
};

/**
 * Run of the timeout logic: the "reaper"
 *
 * @param {runReaperCallback} cb - Callback cb(error, reaped)
 *
 * @callback runReaperCallback
 * @param {Error} error
 * @param {String[]} reaped - Array of `regId`s that have been reaped
 */

RedisData.prototype.runReaper = function runReaper(cb) {
  cb = callback(cb);
  var self = this;
  var client = this.redisClient;

  var reaperScript = "\
local res = redis.call('ZRANGEBYSCORE',KEYS[1], 0, ARGV[1], 'LIMIT', 0, 100 ) \
if #res > 0 then \
   redis.call( 'ZREMRANGEBYRANK', KEYS[1], 0, #res-1 ) \
   return res \
else \
   return false \
end";

  function evalCallback (error, reaped) {
    if (error) self.log('error', error.message || error);
    if (!reaped) reaped = [];

    reaped.forEach(function (regId) {
      self.del(regId);
    });

    if (reaped.length > 0) {
      self.log('debug', 'RedisData.runReaper: reaped ' + reaped.length + ' registrations', reaped);
    }

    cb(error, reaped);
  }

  // the redis client isn't accepting an array of arguments for
  // eval for some reason. This doesn't look as nice, but works
  client.EVAL.apply(client, [reaperScript, 1, self.REGISTRATIONS_SET_KEY, Date.now(), evalCallback]);
};

/**
 * Clear the entire Redis database !!!
 *
 * @param {clearDbCallback} cb - Callback cb(error)
 *
 * @callback clearDbCallback
 * @param {Error} error
 */

RedisData.prototype.clearDb = function clearDb(cb) {
  this.redisClient.flushdb(callback(cb));
};

function callback(cb) {
  return (typeof cb === 'function') ? cb : noop;
}

function noop() {
}
