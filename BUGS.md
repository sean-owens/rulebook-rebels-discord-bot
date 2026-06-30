# Bugs found in testing

- when requesting a library game, it adds all owners to the bring list for the game, instead of figuring out which person will be able to bring it. The owners of the game should get a prompt or something to bring game or not, and once one owner does accept, the rest of the requests should go away.

- gametags sync, add, remove should be in the host cmd block, and the gametags clear should be in the admin cmd block.

- 

- Event channel names and event titles have hard-coded text (e.g. "Monthly"). These should be configurable so other event types can be supported.

---

# TODO (design needed)

- **Recurring event schedules** — if an event re-occurs, there should be a frequency schedule. Needs design: what triggers the next occurrence, how far out to schedule, what happens to the previous channel, etc.
