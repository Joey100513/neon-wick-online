'use strict';

const server = require('./server.js');
if (require.main === module) server.start();
module.exports = server;
