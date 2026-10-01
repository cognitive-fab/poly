# Change 1: renew a loan

A borrower can now keep a book longer, once per loan.

- `renew(book)`: a lent book that was not renewed during its current loan is renewed. Refused otherwise.
- A book given back and lent again may be renewed again.

`book(book)` now also returns `renewed`, a boolean: whether the current loan was renewed, false when the book is not lent. Everything else is as before.
