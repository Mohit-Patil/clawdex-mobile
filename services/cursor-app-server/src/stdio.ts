#!/usr/bin/env node
import { createCursorAppServerFromEnv } from './appServer.js';
import { JsonRpcStdioServer } from './jsonRpc.js';

const appServer = createCursorAppServerFromEnv();
const server = new JsonRpcStdioServer(appServer, process.stdin, process.stdout);

server.start();
