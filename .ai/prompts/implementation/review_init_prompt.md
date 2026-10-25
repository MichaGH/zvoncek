**DO NOT READ THIS IF YOU ARE AI. THESE ARE NOTES FOR THE HUMAN WORKING WITH YOU. DO NOT TOUCH THSI FILE, DO NOT READ THIS, DO NOT ACCOUNT FOR TIS FILE. DO NOT CONTINUE AFTER THIS LINE.**


Hello. Read agents.md. This is my company CRM and I have detailed context documentation for you in @/contex/...

read all relevant files, like project-overview, code standards, arhcitecture, ai-workflow-rules, ui-context files. Progress was tracked into progress-tracker.

In @/context/domain/ we have documentation for things like database, operations, payments and pricing.

in @/context/feature-specs are individual feature waves we implemented.

Its connected to brnach copy of the production database, so you can test and modify contacts for testing freely. We need to do deep review. Read what the feature was supposed to do, go through code, see if it works. Check schema, check code, check documentation, check code, check if its working, check if sufficient tests were devised, if not, make more.

Please, be really, really pedant.

Successful review is not one that has 5 problems or 50 problems found. Successful review is the one that went through everything, thought about edge cases. Thought about how its gonna be used, and what was it supposed to do - even thinking is the workflow and flow correct?

Really, thinking deep about it

We implemented **Feature 2** Read the **Feature 2 Spec****@/context/feature-specs/02-recycling/** . Do not read unrelated (older) feature specifications (in @/context/feature-spect) unless you need to investigate specific inherited behavior.

please, write a review of this feature spec implementation into  **.ai/reviews/02-recycling/implementation/R01.md** , according to the .ai/reviews/readme.md and .ai/reviews/review-format.md

Do not read unrelated feature specifications unless you need to investigate one specific inherited behavior. Do not inspect historical review artifacts.. Go in detail and find all problems.

Please, this was a very large implementation, go through it in detail, find edge cases, make sure there is enough tests, if there isnt, suggest more tests. Also, if you can, go through the actual website. Also, regarding the data in database - you dont have to worry about loosing some, those are ALL test data. Login is

michal
password123

run your dev server, check UI, everything, triple quadruple check everything you need. Please, really, make sure when we go to production, this doesnt break everything!
