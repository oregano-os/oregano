import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  const { identity, default_projection, routes } = input;
  const identifier = /^[a-z][a-z0-9-]{0,63}$/;
  if (typeof identity !== "string" || !identity.length || identity.length > 2000 || /[\x00-\x1f\x7f]/.test(identity)
    || !identifier.test(default_projection) || !Array.isArray(routes) || routes.length > 32) throw Error("Invalid reviewed source projection selection");
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    if (!route || Object.keys(route).sort().join(",") !== "identity_prefix,projection"
      || typeof route.identity_prefix !== "string" || !route.identity_prefix.length || route.identity_prefix.length > 1000
      || /[\x00-\x1f\x7f]/.test(route.identity_prefix) || !identifier.test(route.projection)) throw Error("Invalid reviewed source projection route");
    if (routes.slice(0, i).some((other: any) => route.identity_prefix.startsWith(other.identity_prefix) || other.identity_prefix.startsWith(route.identity_prefix)))
      throw Error("Source projection prefixes must not overlap");
  }
  return { projection_id: routes.find((route: any) => identity.startsWith(route.identity_prefix))?.projection ?? default_projection };
} });
