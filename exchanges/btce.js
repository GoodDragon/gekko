var BTCE = require('btc-e');

var moment = require('moment');
var util = require('../util');
var _ = require('lodash');
var log = require('../log')

var nedb = require('nedb');
var async = require('async');
var db = new nedb({filename: 'btce.db', autoload: true});

var Trader = function(config) {
  this.key = config.key;
  this.secret = config.secret;
  this.pair = 'btc_' + config.currency.toLowerCase();
  this.name = 'BTC-E';

  _.bindAll(this);

  this.btce = new BTCE(this.key, this.secret);
}

Trader.prototype.Trades = function(pair, callback) {
  var self = this;  
  self.btce.makePublicApiRequest(pair, 'trades/2000', callback);
};

Trader.prototype.getTrades = function(since, callback, descending) {
  var self = this;
  var last_tid = next_tid = 0;

  var args = _.toArray(arguments);

  // FIXME:  fetching and updating our db shall be done in an seperate
  // thread (timeout-callback) rather than here.  This method shall
  // only fetch and return from local db.

  async.waterfall([
    function(callback) {
      db.find({}, function(err, docs) {
        if(!docs || docs.length === 0) {
          tid = 1 + _.max(docs, 'tid').tid;
         } 
        log.debug(self.name, 'fetching from tid ' + tid);
        
	//FIXME: Some reason pair didn't work so now it is hardcoded here  
	self.Trades('btc_usd',
          function(err, trades) {
            if(err || !trades || trades.length === 0)
              // return self.retry(self.getTrades, args);
              return self.retry(self.getTrades, callback);
            else if('error' in trades)
              throw 'Error from btce: ' + trades.error
            else {
              trades = trades.reverse();
              _.forEach(trades, function(trade) {
                // convert to int
                trade.amount = Number(trade.amount);
                trade.price = Number(trade.price);
                trade.tid = Number(trade.tid);
                trade.date = Number(trade.date);
                db.insert(trade);
              });
            }
            callback();
        });
       
      });
    },
    function(callback) {
      if(!since) {
        since = new Date().getTime() * 1000;
        since -= (10 * 1000 * 1000);
      }
      since = Math.floor(since / 1000 / 1000);
      log.debug('fetching since ' + since);

      db.find({'date': {$gte: since}}, function(err, docs) {
        docs = _.sortBy(docs, 'tid');
        if(!docs || docs.length === 0)
          return self.retry(self.getTrades, callback);
        callback(null, docs);
      });
    }
  ], function(err, result) {
    if(err) return log.error(self.name, 'error: ' + err);
    callback(result);
  });
}

Trader.prototype.buy = function(amount, price, callback) {
  // Prevent "You incorrectly entered one of fields."
  // because of more than 8 decimals.
  amount *= 100000000;
  amount = Math.floor(amount);
  amount /= 100000000;

  var set = function(err, data) {
    if(err)
      log.error('unable to buy:', err);

    callback(data.order_id);
  };

  // workaround for nonce error
  setTimeout(_.bind(function() {
    this.btce.trade(this.pair, 'buy', price, amount, _.bind(set, this));
  }, this), 1000);
}

Trader.prototype.sell = function(amount, price, callback) {
  // Prevent "You incorrectly entered one of fields."
  // because of more than 8 decimals.
  amount *= 100000000;
  amount = Math.floor(amount);
  amount /= 100000000;

  var set = function(err, data) {
    if(err)
      log.error('unable to sell:', err);

    callback(err, data.order_id);
  };

  // workaround for nonce error
  setTimeout(_.bind(function() {
    this.btce.trade(this.pair, 'sell', price, amount, _.bind(set, this));
  }, this), 1000);
}

// if BTC-e errors we try the same call again after
// 5 seconds or half a second if there is haste
Trader.prototype.retry = function(method, callback, haste) {
  var wait = +moment.duration(haste ? 0.5 : 5, 'seconds');
  log.debug(this.name , 'returned an error, retrying..');
  setTimeout(
    _.bind(method, this),
    wait,
    _.bind(callback, this)
  );
}

Trader.prototype.getPortfolio = function(callback) {
  var calculate = function(err, data) {
    if(err)
      return this.retry(this.btce.getInfo, calculate);

    var portfolio = [];
    _.each(data.funds, function(amount, asset) {
      portfolio.push({name: asset.toUpperCase(), amount: amount});
    });
    callback(err, portfolio);
  }
  this.btce.getInfo(_.bind(calculate, this));
}

Trader.prototype.getTicker = function(callback) {
  // BTCE-e doesn't state asks and bids in its
  // ticker
  var set = function(err, data) {
    var ticker = _.extend(data.ticker, {
      ask: data.ticker.buy,
      bid: data.ticker.sell
    });
    callback(err, ticker);
  }
  this.btce.ticker(this.pair, _.bind(set, this));
}

Trader.prototype.getFee = function(callback) {
  // BTCE-e doesn't have different fees based on orders
  // at this moment it is always 0.2%
  callback(false, 0.002);
}

Trader.prototype.checkOrder = function(order, callback) {
  var check = function(err, result) {
    // btce returns an error when you have no open trades
    // right now we assume on every error that the order
    // was filled.
    //
    // TODO: check whether the error stats that there are no
    // open trades or that there is something else.
    if(err)
      callback(false, true);
    else
      callback(err, !result[order]);
  };

  this.btce.orderList({}, _.bind(check, this));
}

Trader.prototype.cancelOrder = function(order) {
  // TODO: properly test
  var devNull = function() {}
  this.btce.orderList(order, devNull);
}

module.exports = Trader;
