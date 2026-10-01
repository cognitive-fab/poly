# Change 2: cancel while the payment is in progress

A placed order can now be cancelled while its charge is in progress. The provider still answers, and the answer decides whether money must be returned.

- `cancel(order)`: a placed order becomes **cancelling**. No refund is requested yet.
- When the charge of a cancelling order completes `ok`, it went through after all: the order becomes **cancelled** and one refund is requested.
- When it completes `failed`, nothing was taken: the order becomes **cancelled**, and no refund is requested.
- A cancelling order accepts no other command.

`status` in the view can now also be `"cancelling"`. Everything else is as before, including cancelling a draft or a paid order.
