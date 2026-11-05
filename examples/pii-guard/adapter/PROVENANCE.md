# Provenance: edgepii and its dependencies

What the edgepii adapter of the pii-guard example installs (docs/examples/pii-guard.md, S587, Q8). Nothing here is vendored: the packages are installed by `setup.mjs` into a venv outside the repository, and `requirements.txt` holds every hash pip checks. Read from PyPI and from the wheel on 2026-11-05.

## edgepii 0.3.1

- Wheel: `edgepii-0.3.1-py3-none-any.whl`, SHA-256 `620f9b3c47491e337dc51d2265480625e743563de42e7ff9b324827853e2b52f`.
- Licence: Apache-2.0 (`License-Expression: Apache-2.0` in its metadata, and its `LICENSE` file in the wheel's `dist-info/licenses`).
- Author: Raphael Mansuy; repository `https://github.com/raphaelmansuy/edgepii`.
- Requires Python 3.11 or later, `phonenumbers>=8.13` and `pyyaml>=6`.
- Installed source digest, as `adapter.py` measures it over the 32 files of the package: `sha256:66137817a819d6fd751d5c2f0453a4a1cb648dd1bde29b36145da1cff80d65a9`.

## Dependencies of the rules lane

| Package | Version | Licence | Hashes |
|---|---|---|---|
| phonenumbers | 9.0.42 | Apache-2.0 | the wheel `321c92d9...4ecc7d` and the sdist, in `requirements.txt` |
| PyYAML | 6.0.3 | MIT | the wheels for CPython 3.11 to 3.14 and the sdist, in `requirements.txt` |

## The model lane

`multi-open` runs `fastino/gliner2-privacy-filter-PII-multi` at revision `1cb4166094dc58fa8d836429f060d6c95f62b495`, with `gliner2==2.1.0` and `torch`. Its hashed closure (`requirements-model.txt`) and the model card's licence are not recorded yet: the lane is not packaged in this change (A2).

## Conclusion

The rules lane is pinned end to end: the wheel by its hash at install, the installed source by its digest at every start, and the adapter by its own digest in `PIN.json`. An upgrade of any of them is its own change, which reruns the samples and the scores.
