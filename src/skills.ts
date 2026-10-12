import { fail } from "./errors.js";
import { registryToken, type RegistryEntry, type RegistryInfo } from "./registry.js";
import { API_VERSION, serviceToken, type Plugin } from "./types.js";

/** Explicit, immutable skill content; filesystem discovery can be a separate provider plugin. */
export interface SkillDefinition {
  readonly version: string;
  readonly description: string;
  readonly content: string;
  readonly resources?: Readonly<Record<string, string>>;
}
export const skillRegistry = registryToken<SkillDefinition>("skills", skill => {
  if (!skill || typeof skill.version !== "string" || !skill.version.trim() || typeof skill.description !== "string" || typeof skill.content !== "string") fail("INVALID_REGISTRATION", "Skill needs version, description and content");
  if (skill.resources !== undefined && (!skill.resources || Array.isArray(skill.resources) || typeof skill.resources !== "object" || Object.entries(skill.resources).some(([name, value]) => !name.trim() || typeof value !== "string"))) fail("INVALID_REGISTRATION", "Skill resources must map names to text content");
  return { version: skill.version, description: skill.description, content: skill.content, ...(skill.resources ? { resources: skill.resources } : {}) };
});
export interface SkillSummary extends RegistryInfo { readonly skillVersion: string; readonly description: string }
export interface SkillRegistryService {
  list(): readonly SkillSummary[];
  get(name: string): RegistryEntry<SkillDefinition> | undefined;
  readResource(name: string, resource: string): string | undefined;
}
export const skillRegistryService = serviceToken<SkillRegistryService>("SkillRegistryService");

export function createSkillRegistryPlugin(): Plugin {
  return { id: "skill-registry", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [skillRegistryService], requires: [],
    setup(ctx) {
      ctx.provide(skillRegistryService, run => {
        const skills = run.registries.get(skillRegistry);
        return {
          list: () => Object.freeze(skills.list().map(({ info, value }) => Object.freeze({ ...info, skillVersion: value.version, description: value.description }))),
          get: name => skills.get(name),
          readResource: (name, resource) => {
            const resources = skills.get(name)?.value.resources;
            return resources && Object.hasOwn(resources, resource) ? resources[resource] : undefined;
          },
        };
      });
    },
  };
}
