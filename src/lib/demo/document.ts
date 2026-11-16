// A valid one-page PDF generated from fixed synthetic text. No upload or external
// fetch is needed; normal document routes still enforce entity/tenant access.
export function demoReceiptPdf(reference = ""): Buffer {
  const safe = reference.replace(/[^a-zA-Z0-9/._-]/g, "").slice(0, 120);
  const stream = `BT /F1 12 Tf 40 760 Td (CLUB OPS - SYNTHETIC DEMO RECEIPT) Tj 0 -24 Td (Not a fiscal document. No real payment or personal data.) Tj${safe ? ` 0 -24 Td (${safe}) Tj` : ""} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
