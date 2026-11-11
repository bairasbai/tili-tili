import { createHash } from 'node:crypto'
import { pdfInvalid } from './storage.js'

/** A bounded format check. Keep the scanned original bytes and never render the file. */
export function prepareContractPdf(bytes: Buffer) {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.toString('latin1', 0, 9))) throw pdfInvalid()
  const tail = bytes.subarray(-1024).toString('latin1')
  const trailer = /(?:^|[\r\n])startxref[\t \r\n]+(\d{1,10})[\t \r\n]+%%EOF[\t \r\n\f\0]*$/.exec(tail)
  const offset = Number(trailer?.[1])
  if (!Number.isSafeInteger(offset) || offset < 9 || offset >= bytes.length
    || !/^(?:xref[\t \r\n]|\d+\s+\d+\s+obj\b)/.test(bytes.toString('latin1', offset, offset + 48))) throw pdfInvalid()
  return { bytes, width: null, height: null, sha256: createHash('sha256').update(bytes).digest('hex') }
}
