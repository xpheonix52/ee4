// Manual check: can this machine reach WhatsApp and get a pairing QR? Run: npx tsx tests/wa-probe.ts
process.env.DATA_DIR ||= '/tmp/sb-wa-probe'
const { BaileysTransport } = await import('../server/wa.ts')
const t = new BaileysTransport('probe', {
  onStatus: (s, e) => { console.log('status:', s, e?.qr ? `(QR image, ${e.qr.length} bytes)` : ''); if (s === 'qr') { t.stop(); process.exit(0) } },
  onMessage: () => {}, onReceipt: () => {},
})
await t.start()
setTimeout(() => { console.log('no QR within 30s'); process.exit(1) }, 30000)
