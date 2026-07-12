# Project-local Microsoft Visual C++ Runtime

These signed x64 Microsoft runtime libraries are loaded privately by the ASR Python process so CTranslate2 does not depend on the machine-wide Visual C++ installation.

- Version: `14.44.35211.0`
- Architecture: `x86-64`
- Publisher signature: `Microsoft Windows`
- Official redistributable: <https://aka.ms/vs/17/release/vc_redist.x64.exe>

The files remain Microsoft redistributable components and are governed by the Microsoft Visual Studio licensing terms. They are not covered by the project's GPL license.

| File | SHA-256 |
| --- | --- |
| `concrt140.dll` | `6CBEB6622C28EB8CD2181B3C2CD083D8553075DAE207A65F2E6A4690B2F0CE4C` |
| `msvcp140.dll` | `410AC52E5D6F6764B19D7ADDA8F325BC18749BA5DE4EC9752A03D618F3E2B922` |
| `msvcp140_codecvt_ids.dll` | `516BFBBD5D759D09C4254F51084A0212E5163ACEDD9769180532A9F12C878731` |
| `vcruntime140.dll` | `6E9523D0F77936934CC79C514FB4FE5FEC3E1FFACC5C8083B69640BDEED124FB` |
| `vcruntime140_1.dll` | `3667CA2D06F0AD84409A5711602C2E745D3C52889FC3E7FE99C87841DF9DDCB7` |
