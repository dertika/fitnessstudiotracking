// QR-Scanner über die Kamera. iOS Safari hat keine BarcodeDetector-API,
// daher werden die Kamerabilder mit jsQR (vendor/jsQR.js, global) dekodiert.

export class Scanner {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.stream = null;
    this.running = false;
  }

  async start(onResult) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Kamera wird von diesem Browser nicht unterstützt (HTTPS erforderlich).');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.running = true;

    const tick = () => {
      if (!this.running) return;
      const { videoWidth: w, videoHeight: h } = this.video;
      if (w && h) {
        // Auf max. 640 px skalieren – schneller und für QR-Codes ausreichend.
        const scale = Math.min(1, 640 / Math.max(w, h));
        const cw = Math.round(w * scale);
        const ch = Math.round(h * scale);
        this.canvas.width = cw;
        this.canvas.height = ch;
        this.ctx.drawImage(this.video, 0, 0, cw, ch);
        const img = this.ctx.getImageData(0, 0, cw, ch);
        const code = window.jsQR(img.data, cw, ch, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) {
          this.stop();
          onResult(code.data);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }
}

// QR-Code aus einem Foto lesen (Fallback, falls die Live-Kamera nicht klappt).
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
  return code?.data || null;
}
