
# Code Standards

## General

* Keep modules small and single-purpose.
* Fix root causes — do not layer workarounds.
* Do not mix unrelated concerns in one component or route.
* Respect the system boundaries defined in `context/architecture.md`.

## TypeScript

* Strict mode is required throughout the project.
* Avoid `any`; use explicit interfaces or narrowly scoped types.
* Validate unknown external input at system boundaries before trusting it.
* Prefer `interface` for extensible object contracts.
* Use `type` for unions, mapped types, utility compositions, and cases where it provides clearer semantics

## Next.js

* Default to React Server Components.
* Add `"use client"` only when the component needs browser interactivity, hooks, or real-time state.
* Keep route handlers focused on a single responsibility.
* UI components, Server Actions, and Route Handlers must not implement booking, pricing, availability, or payment rules directly.
* They should call the appropriate domain/server module instead.
