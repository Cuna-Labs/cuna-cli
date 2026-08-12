# Third-Party Notices

Cuna CLI depends on `@xterm/headless` version `6.0.0`, distributed under the
MIT License.

- Copyright (c) 2017-2019, The xterm.js authors
- Copyright (c) 2014-2016, SourceLair Private Company
- Copyright (c) 2012-2013, Christopher Jeffrey

The complete license text is available in the immutable upstream source at
<https://github.com/xtermjs/xterm.js/blob/6.0.0/LICENSE>.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Native bridge runtime

The separately distributed native bridge uses the following pinned runtime
dependencies. Their exact versions, registry checksums, and dependency edges
are also recorded in the native SPDX SBOM generated from `native/Cargo.lock`.

- `windows-sys` 0.61.2 — MIT OR Apache-2.0
- `windows-link` 0.2.1 — MIT OR Apache-2.0
- `zeroize` 1.9.0 — Apache-2.0 OR MIT

The Windows version-resource build uses `winresource` 0.1.31 (MIT) and its
locked build-only dependency graph. Build-only packages are not linked into the
native runtime binary, but remain represented in build provenance and the
native SPDX document.

Canonical license sources:

- <https://crates.io/crates/windows-sys/0.61.2>
- <https://crates.io/crates/zeroize/1.9.0>
- <https://crates.io/crates/winresource/0.1.31>
