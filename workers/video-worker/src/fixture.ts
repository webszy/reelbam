/** Synthetic ISO-BMFF fixture authored for Reelbam tests. It is not a ShrimpReel asset. */
const BINARY = atob('AAAAGGZ0eXBpc29tAAAAAGlzb21pc28yAAAAHW1kYXRyZWVsYmFtLW1vY2stdmlkZW8tdjE=')
export const MOCK_FIXTURE_BYTES = Uint8Array.from(BINARY, char => char.charCodeAt(0))
