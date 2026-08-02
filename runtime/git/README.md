# Portable Git Runtime

This directory is reserved for the project-provided MinGit for Windows runtime.
The application resolves `cmd/git.exe` from this directory and never falls back to
the user's global Git installation. The packaged binary and its accompanying
license files must be kept together when building a release.
