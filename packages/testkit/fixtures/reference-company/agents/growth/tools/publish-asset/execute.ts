import { defineCompanyTool } from "@companyos/tool-sdk";

export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("artifact.publish", input);
  },
});
