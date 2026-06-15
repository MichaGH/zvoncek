Databáza sa zalohuje pravidelne (90 dní história) pomocou Github Actions. Medzi Actions → Workflow → "Zálohovanie" → Workflow files → stiahnúť .dump

.dump je custom format, takto ho premeniť na niečo čitatelne

`pg_restore db.dump -f db.sql`

ak by som chcel nahrať zalohu, 

```
pg_restore \
  --no-owner \
  --no-acl \
  --clean \
  -d "postgresql://neondb_owner:HESLO@ep-ancient-glitter-asm0xyun.c-4.eu-central-1.aws.neon.tech/neondb?sslmode=require" \
  zvoncek_2026-06-15.dump
```
