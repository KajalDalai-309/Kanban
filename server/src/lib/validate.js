import { badRequest } from './errors.js';

// Parses data with a zod schema and turns failures into a 400 response.
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(`Invalid request: ${issues[0].path || 'body'} ${issues[0].message}`, { issues });
  }
  return result.data;
}
