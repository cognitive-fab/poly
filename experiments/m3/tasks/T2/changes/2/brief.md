# Change 2: close the inventory for a stocktake

The inventory can now be closed while its units are counted.

- `close()`: an open inventory becomes closed. Refused when it is closed.
- `open()`: a closed inventory becomes open. Refused when it is open.
- While the inventory is closed, it answers every `Reserve` with `OutOfStock` and reserves nothing, and `restock()` is refused. A `Release` is still taken.

The inventory starts open. `stock()` now returns `{ available, reserved, open }`, with `open` a boolean. Everything else is as before.
