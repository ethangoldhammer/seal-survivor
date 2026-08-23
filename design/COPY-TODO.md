# Copy waiting to be written

Lines Claude staged as lorem ipsum because they needed to exist for a feature
to be testable. Each one is a brief, not a draft — replace the lorem in the
listed file with your own words and delete the entry.

`npm run test:copy` lists everything still outstanding and blocks `npm run
ship` until this is empty.

Rows in a CSV that has a `notes` column carry their brief there instead; this
file is for the ones that don't (and for strings in `.js`).

| where | what the line has to do |
| --- | --- |
| _(nothing outstanding)_ | |
