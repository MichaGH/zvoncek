# Architecture Context

## Stack

| Layer         | Technology               | Role                       |
| ------------- | ------------------------ | -------------------------- |
| Framework     | Next.js + TypeScript     | Full-stack application     |
| Styling       | Tailwind CSS             | Customer and admin styling |
| UI primitives |                          |                            |
| Database      | Neon PostgreSQL + Prisma |                            |
| Auth          |                          |                            |

## Invariants

1. PostgreSQL is the source of truth for booking-critical data.
