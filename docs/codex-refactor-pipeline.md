You are working on my internal CRM/calling dashboard project.

Project context:

* Next.js App Router
* TypeScript
* Prisma + Neon Postgres
* NextAuth Credentials
* zod, bcrypt
* shadcn/ui
* This is a real internal company app, but also a learning project.

Business workflow:

* The database model is currently called `<span>Lead</span>`.
* IMPORTANT: Do NOT rename the Prisma model `<span>Lead</span>`, `<span>leadId</span>`, relations, schema fields, generated Prisma types, or database columns.
* In the database, `<span>Lead</span>` is the central CRM record. It can represent:
  * a raw contact/company to call,
  * a call target,
  * an interested business opportunity,
  * a lost/won record,
  * later maybe a client/project.
* UI/business concepts:
  * `<span>/dashboard/calls</span>` = marketing call queue. Marketing users call assigned contacts here.
  * `<span>/dashboard/calls/history</span>` = history of marketing call work, not full lead history.
  * `<span>/dashboard/pipeline</span>` = manager/developer view for active business opportunities.
  * `<span>/dashboard/pipeline/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span></span>` = full detail/edit view for one business opportunity.
  * Future `<span>/dashboard/contacts</span>` = master database of all contact/company records.
  * Future `<span>/dashboard/contacts/new</span>` = create a new company/contact that starts in the call workflow.
* The current `<span>/dashboard/leads</span>` feature should become `<span>/dashboard/pipeline</span>`.
* This is a naming/UI/feature refactor, NOT a database refactor.

Main task:
Refactor the old dashboard feature named `<span>leads</span>` into `<span>pipeline</span>`.

Do:

1. Move the route:

   * from `<span>app/dashboard/leads/page.tsx</span>`
   * to `<span>app/dashboard/pipeline/page.tsx</span>`
2. Move the detail route:

   * from `<span>app/dashboard/leads/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span>/page.tsx</span>`
   * to `<span>app/dashboard/pipeline/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span>/page.tsx</span>`
3. Rename components:

   * `<span>components/leads/LeadDetail.tsx</span>` → `<span>components/pipeline/PipelineDetail.tsx</span>`
   * `<span>components/leads/LeadsTable.tsx</span>` → `<span>components/pipeline/PipelineTable.tsx</span>`
   * `<span>components/leads/StatusTabs.tsx</span>` → `<span>components/pipeline/PipelineStatusTabs.tsx</span>`
4. Update component names and imports:

   * `<span>LeadDetail</span>` → `<span>PipelineDetail</span>`
   * `<span>LeadsTable</span>` → `<span>PipelineTable</span>`
   * `<span>StatusTabs</span>` → `<span>PipelineStatusTabs</span>`
5. Update all links and route references:

   * `<span>/dashboard/leads</span>` → `<span>/dashboard/pipeline</span>`
   * `<span>/dashboard/leads/${id}</span>` → `<span>/dashboard/pipeline/${id}</span>`
6. Use feature folders with `<span>index.ts</span>` because this project prefers that style:

   * pipeline queries should live in `<span>lib/queries/pipeline/index.ts</span>`
   * pipeline actions should live in `<span>lib/actions/pipeline/index.ts</span>`
   * calls-related history should stay under calls-specific naming, not generic global history unless truly shared.
7. Rename query/action functions where appropriate:

   * `<span>getLeadDetail</span>` should become something like `<span>getPipelineDetail</span>`
   * lead list query should become something like `<span>getPipelineList</span>`
   * Do NOT rename variables like `<span>lead.id</span>` or Prisma model usage where it would cause unnecessary churn. It is OK for implementation variables to still be called `<span>lead</span>` because the DB model is still `<span>Lead</span>`.
   * Route/UI-facing names should use `<span>pipeline</span>`.
8. Extract shared labels/dictionaries into a shared file:
   Create something like:

   * `<span>lib/dictionaries.ts</span>`
     or
   * `<span>lib/labels.ts</span>`

   Put shared enum labels there, because these are not pipeline-specific and will be reused by calls, calls history, contacts, admin, etc.

Use this content:

```
import { ActivityType, CallOutcome, LeadStatus } from "@/app/generated/prisma/enums";

export const STATUS_LABEL: Record<LeadStatus, string> = {
    NEW: "Nový",
    CALLING: "Volá sa",
    ACTIVE: "Aktívny",
    SNOOZED: "Spí",
    WON: "Vyhraný",
    LOST: "Stratený",
    UNREACHABLE: "Nedostupný",
};

export const STATUS_VARIANT: Record<
    LeadStatus,
    "default" | "secondary" | "outline" | "destructive"
> = {
    NEW: "outline",
    CALLING: "outline",
    ACTIVE: "default",
    SNOOZED: "secondary",
    WON: "secondary",
    LOST: "destructive",
    UNREACHABLE: "destructive",
};

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
    NO_ANSWER: "Nezdvihli",
    BAD_NUMBER: "Zlé číslo",
    NOT_INTERESTED: "Nemajú záujem",
    CALL_AGAIN: "Zavolať neskôr",
    WANTS_QUOTE: "Chcú cenovú ponuku",
    WANTS_DESIGN: "Chcú návrh",
    WANTS_EMAIL: "Máme napísať",
    SNOOZE: "Ozvať sa neskôr",
    POSITIVE: "Pozitívny posun",
};

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
    CALL: "Hovor",
    QUOTE_SENT: "Poslaná CP",
    DESIGN_SENT: "Poslaný návrh",
    EMAIL_SENT: "Email",
    SMS_SENT: "SMS",
    NOTE: "Poznámka",
};
```

9. Search the codebase for duplicated versions of these dictionaries and replace them with imports from the shared file.
10. Carefully identify other genuinely shared utilities:

* If a helper is used by multiple features or clearly will be reused, move it to a sensible shared file under `<span>lib</span>`, for example:
  * `<span>lib/dictionaries.ts</span>`
  * `<span>lib/formatters.ts</span>`
  * `<span>lib/leadFlow.ts</span>`
  * `<span>lib/utils.ts</span>`
* Do NOT over-refactor. Do not create generic helper files for things used only once.
* Prefer small, obvious shared files over abstract “tools” files.
* If unsure, leave it local and mention it in your final summary.

11. Preserve current working behavior:

* `<span>/dashboard/calls</span>` must keep working.
* `<span>/dashboard/calls/history</span>` must keep working.
* Pipeline should behave like the old leads page, only renamed/reorganized.
* Do not change business logic unless necessary to make the refactor compile.
* Do not change the database schema.
* Do not change Prisma migrations.
* Do not regenerate or edit Prisma schema unless imports require generated enum paths only.
* Do not change authentication behavior.
* Do not change role/permission behavior.

12. Do NOT add redirects from `<span>/dashboard/leads</span>` to `<span>/dashboard/pipeline</span>` unless absolutely necessary for temporary compatibility.
    This is still in development, so I prefer a clean move, not old route compatibility.
13. Keep `<span>AddLeadForm</span>` out of pipeline unless it is currently required for the old page to compile.
    Conceptually, adding new records should later become:

* `<span>/dashboard/contacts/new</span>`
* `<span>ContactCreateForm</span>`
  But do not fully implement contacts now unless required.
  If there is old `<span>/dashboard/leads/new</span>`, either leave it untouched for now or tell me what should be moved later.

14. After refactor:

* Run TypeScript check / build / lint according to the project scripts.
* Fix broken imports.
* Fix route links.
* Fix type errors.
* Give me a final summary:
  * files moved
  * files renamed
  * shared dictionaries created
  * imports updated
  * anything intentionally left for later
  * any warnings or TODOs
