'use client';

import qrcode from 'qrcode-generator';

/**
 * QR-код рисуется в браузере (SVG из модулей матрицы): секрет второго фактора не уходит на сторонние сервисы.
 */
export function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 2;
  const total = count + margin * 2;
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) cells.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${total} ${total}`} shapeRendering="crispEdges">
      <rect width={total} height={total} fill="#fff" />
      <path d={cells.join('')} fill="#000" />
    </svg>
  );
}
