const fs = require('fs');
const Server = require('./src/server');

let json;

try {
	json = require('./config');
} catch (error) {}

const config = Object.assign({
	pair: 'BTCUSD',
	port: 3000,
	delay: 200,
}, json || {});

if (!config.exchanges || !config.exchanges.length) {
	config.exchanges = process.argv.slice(2);

	if (!config.exchanges.length) {
		fs.readdirSync('./src/exchanges/').forEach(file => {
			/\.js$/.test(file) && config.exchanges.push(file.replace(/\.js$/, ''));
		})
	}
}

for (let name of config.exchanges) {
	const exchange = require('./src/exchanges/' + name);

	config.exchanges[config.exchanges.indexOf(name)] = new exchange(config[name] || {});
}

new Server({
	port: config.port,
	delay: config.delay,
	pair: config.pair,
	exchanges: config.exchanges
});