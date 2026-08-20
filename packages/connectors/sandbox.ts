import { createHash } from "node:crypto";
import type { CapabilityCallContext, CapabilityResult, Connector } from "../capabilities/contracts.ts";

export class ArtifactSandboxConnector implements Connector {
  readonly id = "oregano/artifact-sandbox";
  readonly version = "1.0.0";
  readonly capabilities = ["artifact.publish"] as const;
  readonly artifacts = new Map<string, { content: string; contentType: string; digest: string }>();

  async invoke(capability: string, input: any): Promise<CapabilityResult> {
    if (capability !== "artifact.publish") throw new Error(`Unsupported Capability '${capability}'.`);
    const digest = createHash("sha256").update(input.content).digest("hex");
    const existing = this.artifacts.get(input.artifact_id);
    if (existing && existing.digest !== digest) throw new Error(`Artifact '${input.artifact_id}' already exists with different content.`);
    this.artifacts.set(input.artifact_id, { content: input.content, contentType: input.content_type, digest });
    return {
      output: { artifact_id: input.artifact_id, url: `sandbox://artifacts/${input.artifact_id}`, digest },
      evidence: { simulated: true, artifact_id: input.artifact_id, digest },
    };
  }
}

interface CampaignState {
  campaignId: string;
  campaignKey: string;
  assets: string[];
  stopped: string[];
  dailyBudget: number;
  days: number;
  maxSpend: number;
  conversions: Array<{ id: string; asset: string }>;
}

export class MarketingSandboxConnector implements Connector {
  readonly id = "oregano/marketing-sandbox";
  readonly version = "1.0.0";
  readonly capabilities = [
    "marketing-campaign.launch",
    "marketing-campaign.read-report",
    "marketing-campaign.stop-asset",
    "conversion.record",
  ] as const;
  readonly campaigns = new Map<string, CampaignState>();

  async invoke(capability: string, input: any, context: CapabilityCallContext): Promise<CapabilityResult> {
    if (capability === "marketing-campaign.launch") {
      const campaignId = `SIM-${createHash("sha256").update(context.idempotencyKey ?? input.campaign_key).digest("hex").slice(0, 10).toUpperCase()}`;
      const state: CampaignState = {
        campaignId,
        campaignKey: input.campaign_key,
        assets: [...input.assets],
        stopped: [],
        dailyBudget: input.daily_budget,
        days: input.days,
        maxSpend: input.daily_budget * input.days,
        conversions: [],
      };
      const existing = this.campaigns.get(input.campaign_key);
      if (existing && existing.campaignId !== campaignId) throw new Error(`Campaign '${input.campaign_key}' already launched.`);
      this.campaigns.set(input.campaign_key, existing ?? state);
      const current = this.campaigns.get(input.campaign_key)!;
      return {
        output: { campaign_id: current.campaignId, status: "active", max_spend: current.maxSpend, simulated: true },
        evidence: { simulated: true, campaign_id: current.campaignId, max_spend: current.maxSpend },
      };
    }
    const state = this.campaigns.get(input.campaign_key);
    if (!state) throw new Error(`Unknown campaign '${input.campaign_key}'.`);
    if (capability === "conversion.record") {
      if (!state.conversions.some((entry) => entry.id === input.conversion_id)) {
        state.conversions.push({ id: input.conversion_id, asset: input.asset });
      }
      return {
        output: { conversion_id: input.conversion_id, recorded: true },
        evidence: { simulated: true, conversion_id: input.conversion_id, recorded: true },
      };
    }
    if (capability === "marketing-campaign.stop-asset") {
      if (!state.assets.includes(input.asset)) throw new Error(`Asset '${input.asset}' is not active.`);
      if (!state.stopped.includes(input.asset)) state.stopped.push(input.asset);
      return {
        output: { campaign_id: state.campaignId, stopped_asset: input.asset, max_spend: state.maxSpend },
        evidence: { simulated: true, campaign_id: state.campaignId, stopped_asset: input.asset, max_spend: state.maxSpend },
      };
    }
    if (capability === "marketing-campaign.read-report") {
      const activeAssets = state.assets.filter((asset) => !state.stopped.includes(asset));
      return {
        output: {
          campaign_id: state.campaignId,
          status: "active",
          max_spend: state.maxSpend,
          active_assets: activeAssets,
          stopped_assets: [...state.stopped],
          conversions: state.conversions.length,
          simulated: true,
        },
        evidence: { simulated: true, campaign_id: state.campaignId, observed_at: "sandbox-deterministic" },
      };
    }
    throw new Error(`Unsupported Capability '${capability}'.`);
  }
}
