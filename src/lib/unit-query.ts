import { Prisma } from "@/generated/prisma/client";

/** Same precedence as loadUnits, including empty armies and pre-units saves. */
export const storedUnitArray = Prisma.sql`
  CASE WHEN jsonb_typeof(data -> 'units') = 'array' THEN data -> 'units'
       WHEN jsonb_typeof(data -> 'servants') = 'array' THEN data -> 'servants'
       ELSE '[]'::jsonb END
`;
