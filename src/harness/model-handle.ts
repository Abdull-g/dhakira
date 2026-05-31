// The model-agnostic seam the harness generates text through.
// This interface MUST NOT depend on any concrete model backend.

/** Abstract handle the harness generates text through. */
export interface ModelHandle {
  /** Generate text for a prompt. If jsonSchema is provided AND supported, constrain output to it. */
  generate(
    prompt: string,
    opts: {
      jsonSchema?: Readonly<Record<string, unknown>>
      maxTokens?: number
      temperature?: number
    },
  ): Promise<{ text: string; constrained: boolean }>
  /** Whether this handle can enforce grammar/json-schema constraints. */
  supportsConstraint(): boolean
  dispose?(): Promise<void>
}
