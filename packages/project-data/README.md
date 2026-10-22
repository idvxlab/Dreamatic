# Project data compatibility

Shared configuration validation and application data helpers extracted before
removing the previous Dreamatic agent implementation. This package does not
create agent sessions, call model providers, register tools, execute workflows,
load role prompts or validate/approve newly authored agent specifications.

Historical role/event names and file projections remain necessary for unchanged
UI rendering and export of existing projects. `syncProjectContext` updates only
application project metadata when attaching a conversation. Configuration field
names and model capability validation remain compatible with the existing API.
