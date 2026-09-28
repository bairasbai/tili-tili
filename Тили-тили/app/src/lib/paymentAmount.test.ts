import { describe, expect, it } from 'vitest'
import { parsePaymentRubles } from './paymentAmount'
describe('018: точные копейки из формы платежа', () => {
  it.each([['0,01',1],['1234.56',123456],[' 1 234,50 ',123450],['10',1000],['90071992547409.91',9007199254740991]])('разбирает %s без float-округления', (input,value) => expect(parsePaymentRubles(input)).toBe(value))
  it.each(['0','-1','1e4','0.001','1,2,3','','90071992547409.92','текст'])('отклоняет %s', input => expect(parsePaymentRubles(input)).toBeNull())
})
