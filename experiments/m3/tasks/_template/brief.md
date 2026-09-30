# <Task title>

<What the system does, in the words of a product brief: the actors, the commands, what each command does, and when it is refused, with the reason the caller sees. Observable behaviour only.>

## The interface

Implement `host.ts`. Its default export creates a fresh system.

<For a multi-machine task:> The parts of the system talk by messages. A message is not delivered until `deliver(id)` or `deliverAll()` is called, and messages may arrive in any order.

## Conclusion

<One paragraph restating what must hold.>
