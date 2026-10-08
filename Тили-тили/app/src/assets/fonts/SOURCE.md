# Self-hosted design fonts

These unmodified WOFF2 binaries and complete license texts were extracted from the pinned Fontsource npm archives below. No npm dependency was added. Retrieval date: 2026-10-08.

Local CSS keeps the existing family names, font-display: swap, and requested design ranges: Inter normal 300–800; Playfair Display normal 400–700 and italic 400–500. The Inter weight-only package variant has only wght; no new automatic optical-size axis is introduced. Each binary retains its shipped full variation range. All shipped subsets are included; CSS unicode-range values are copied unchanged from the package CSS.

Actual fontTools TTFont inspection verified every fvar axis shown below and the combined cmap coverage of each selected family/style for the 33 Russian uppercase/lowercase letters (including Ё/ё), English A–Z/a–z, digits, №, em/en dashes and guillemets. This is a binary/source check; browser font loading and offline rendering require the separate full/browser gate.

## @fontsource-variable/inter 5.3.0

- Archive: [https://registry.npmjs.org/@fontsource-variable/inter/-/inter-5.3.0.tgz](https://registry.npmjs.org/@fontsource-variable/inter/-/inter-5.3.0.tgz)
- SHA-256: `D26710DD38E7217484A1D47EE76C024977EC550548876F26D06ED1844AF09A14`
- npm integrity: `sha512-OupL48va4JNofb97w6NYeF9S7W/kHNKM0Er8Dem5nqi4jeOLrVJDoE8tZEpnMJmtkvNbB1EIPPwHcdkF6b1oUA==`
- Upstream metadata: `v20`, last modified `2025-09-10`.
- Full unchanged OFL-1.1 license: [Inter-LICENSE.txt](Inter-LICENSE.txt); SHA-256 `3B0A5FCA3D17942CDE889069889DEDBBBD075E9B599968C82A95F4D944E9B345`.
- Subsets: cyrillic, cyrillic-ext, greek, greek-ext, latin, latin-ext, vietnamese.

- Source CSS `package/wght.css` SHA-256 `78D97E4CBC385B8D0F86F21F650073C149EDA98423BBDC49B13A13836D81E571`.

## @fontsource-variable/playfair-display 5.3.0

- Archive: [https://registry.npmjs.org/@fontsource-variable/playfair-display/-/playfair-display-5.3.0.tgz](https://registry.npmjs.org/@fontsource-variable/playfair-display/-/playfair-display-5.3.0.tgz)
- SHA-256: `5D9A6609CCC3C3BCBA68C5B66981CCE7D731BF5BB6E64A2CA6045AB05E527788`
- npm integrity: `sha512-IHdzTvE8eGIXHteZql7KXoqdc3Gfm+Zs1u4XlSC3MeplkwviT3sx/P6gI0tLwg/xIYLF4ZJYveZ5V+bl9cnDwA==`
- Upstream metadata: `v40`, last modified `2025-09-11`.
- Full unchanged OFL-1.1 license: [Playfair-Display-LICENSE.txt](Playfair-Display-LICENSE.txt); SHA-256 `C052AAFD2A71E90BCEE6E69F475029D430A10D548C08FFCAE350171F0E9668B1`.
- Subsets: cyrillic, latin, latin-ext, vietnamese.

- Source CSS `package/wght.css` SHA-256 `342EA68FAEB4AA6502A81F185F70399378608296BA19E536A2EA27E6CEE1A5DA`.
- Source CSS `package/wght-italic.css` SHA-256 `C88A8C8BAC230F4FB36948509B70F3A61122451B1DADB5389A373944A540337D`.

## Asset integrity

| File | Bytes | SHA-256 | Actual wght min/default/max |
|---|---:|---|---|
| `inter-cyrillic-ext-wght-normal.woff2` | 25960 | `CA157063339AC4AD418F214F3ABFED119B0798AB4D377386CE5C9E5A7A435EBD` | 100/400/900 |
| `inter-cyrillic-wght-normal.woff2` | 18748 | `71D5EE93CC1E9F1D520A3A8B66456DE18C7879D8DF09D57FCD2EAFF75FEF0075` | 100/400/900 |
| `inter-greek-ext-wght-normal.woff2` | 11232 | `6E9E020A25F9B56D418F2C085B1D3C09725A4DA23FE693A5B463064606732190` | 100/400/900 |
| `inter-greek-wght-normal.woff2` | 18996 | `1BE3448E292FBF05FFE176FE1E43F135013D50B1E7D324AD1A558F623D3BB6F6` | 100/400/900 |
| `inter-vietnamese-wght-normal.woff2` | 10252 | `5C66F9E07E90C6D4AC4922CC68D60DE26C17B1858E677FB5E603FCE3952B3FF2` | 100/400/900 |
| `inter-latin-ext-wght-normal.woff2` | 85068 | `34B9C504CAB7A73E37B746343A449132E56CF7B5481AF2CB81DC74DCFF25C956` | 100/400/900 |
| `inter-latin-wght-normal.woff2` | 48256 | `3100E775E8616CD2611BEECFA23A4263D7037586789B43F035236A2E6FBD4C62` | 100/400/900 |
| `playfair-display-cyrillic-wght-normal.woff2` | 21152 | `C108681CBA6A9820BFF52F4A1A4A1D9EDF356B347BD79B7C61E916028E8A8B54` | 400/400/900 |
| `playfair-display-vietnamese-wght-normal.woff2` | 9112 | `EF6446229B59773E671021650EF3882CF35806DAE723CE047DE87C0A6633039A` | 400/400/900 |
| `playfair-display-latin-ext-wght-normal.woff2` | 21140 | `42898AD49A6B23F32B109243E1DF596EDF831015ED685F429E4DAFBB181D599D` | 400/400/900 |
| `playfair-display-latin-wght-normal.woff2` | 38404 | `E0C764A8E9E1CCE92163C55BAC4B2AD6CD4CF8C696CE2289AB5C41565E65B7E2` | 400/400/900 |
| `playfair-display-cyrillic-wght-italic.woff2` | 23304 | `51B2DAC698333379DC3A3486393FBA787D17F1DCBCB50F46582CA759D53C25FC` | 400/400/900 |
| `playfair-display-vietnamese-wght-italic.woff2` | 9568 | `6B8BFD228577635A5F45BEE13C8DD4A900EBA6AEB36AF1680838AEA3CBD7E412` | 400/400/900 |
| `playfair-display-latin-ext-wght-italic.woff2` | 23380 | `B9DFF4AEC6D8EF27AF595330C808C455FCC3FF46881642AA6028ED4E27A96F89` | 400/400/900 |
| `playfair-display-latin-wght-italic.woff2` | 38804 | `54AF24BD0F911F0FD7399D5445EA2023FF501D6A69F2D728F1213072F977AB14` | 400/400/900 |

Total font binary bytes: 403376 (sum of the 15 rows above).

The original Google Fonts stylesheet returned browser-dependent assets. Byte-for-byte equality with that historical CDN response is not claimed; the local family/style/weight contract and actual RU/EN glyph coverage are verified here.
