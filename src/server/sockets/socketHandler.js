module.exports = function (wss) {
  wss.on('connection', (ws) => {
    console.log('A user connected');

    ws.on('message', (message) => {
      const msg = JSON.parse(message);
      console.log('Received:', msg);
      ws.send('Message received');
    });

    ws.on('disconnect', () => {
      console.log('User disconnected');
    });
  });
};
