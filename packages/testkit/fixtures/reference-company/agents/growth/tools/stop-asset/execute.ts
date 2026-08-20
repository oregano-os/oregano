import { defineCompanyTool } from "@companyos/tool-sdk";

export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("marketing-campaign.stop-asset", input);
  },
});
