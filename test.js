const { default: makeWASocket, useMultiFileAuthState, Browsers, fetchMessageHistory } = require('@whiskeysockets/baileys');
async function run() {
  const { state } = await useMultiFileAuthState('baileys_auth');
  const sock = makeWASocket({ auth: state, browser: Browsers.ubuntu('Test') });
  
  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open') {
      try {
        const groups = await sock.groupFetchAllParticipating();
        const jid = Object.keys(groups)[0];
        console.log('Testing history fetch on:', jid);
        const msgs = await sock.fetchMessageHistory(10, { remoteJid: jid, id: '' });
        console.log('Fetched:', Array.isArray(msgs) ? msgs.length : msgs);
      } catch (e) {
        console.log('Err:', e.message);
      }
      process.exit();
    }
  });
}
run();
