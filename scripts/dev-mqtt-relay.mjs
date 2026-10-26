// 本地 MQTT over WebSocket 中继，供联机回归使用。
import aedes from 'aedes'
import { WebSocketServer, createWebSocketStream } from 'ws'

const port = Number(process.env.PORT) || 8788
const broker = aedes()
const server = new WebSocketServer({ port })
server.on('connection', (socket) => broker.handle(createWebSocketStream(socket)))
console.log(`light-chess MQTT relay listening on ws://localhost:${port}`)
