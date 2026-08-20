import { defineCompanyTool } from "@companyos/tool-sdk";

export default defineCompanyTool({
  execute(_input: { permit_id: string }) {
    return { normalized_status: "unknown" };
  },
});
