import type { Capability, GenerationInput, GenerationMode } from '@reelbam/video-contracts'
import { frozenCopy, isNonBlank, isRecord } from './value.ts'

export class VideoValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'VideoValidationError'
    this.field = field
  }
}

const MODES: readonly GenerationMode[] = ['text-to-video', 'image-to-video', 'reference-to-video']

function invalid(field: string, message: string): never {
  throw new VideoValidationError(field, message)
}

function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${field}.${key}`, 'Unexpected field')
  }
}

/** 校验未知输入，而非仅把 JSON 强制断言为联合类型；返回与调用者解耦的对象。 */
export function validateGenerationInput(value: unknown): GenerationInput {
  if (!isRecord(value)) invalid('input', 'Expected a generation input object')
  if (!MODES.includes(value.mode as GenerationMode)) invalid('mode', 'Unsupported generation mode')
  if (!isNonBlank(value.modelId)) invalid('modelId', 'Model ID is required')
  const allowed = ['modelId', 'mode', 'prompt', 'parameters']
  if (value.mode !== 'text-to-video') allowed.push('imageAssetId')
  if (value.mode === 'reference-to-video') allowed.push('referenceVideoAssetId')
  keys(value, allowed, 'input')
  if (value.mode !== 'text-to-video' && !isNonBlank(value.imageAssetId)) {
    invalid('imageAssetId', 'Image asset ID is required')
  }
  if (value.mode === 'reference-to-video' && !isNonBlank(value.referenceVideoAssetId)) {
    invalid('referenceVideoAssetId', 'Reference video asset ID is required')
  }
  if (value.mode === 'text-to-video' || Object.hasOwn(value, 'prompt')) {
    if (!isNonBlank(value.prompt)) invalid('prompt', 'Prompt must be a non-empty string')
  }
  const parameters = value.parameters
  if (!isRecord(parameters)) invalid('parameters', 'Parameters are required')
  keys(parameters, ['durationSeconds', 'resolution', 'aspectRatio', 'seed', 'generateAudio'], 'parameters')
  if (typeof parameters.durationSeconds !== 'number' || !Number.isSafeInteger(parameters.durationSeconds) || parameters.durationSeconds <= 0) {
    invalid('parameters.durationSeconds', 'Duration must be a positive integer')
  }
  if (!isNonBlank(parameters.resolution)) invalid('parameters.resolution', 'Resolution is required')
  if (Object.hasOwn(parameters, 'aspectRatio') && !isNonBlank(parameters.aspectRatio)) {
    invalid('parameters.aspectRatio', 'Aspect ratio must be a non-empty string')
  }
  if (Object.hasOwn(parameters, 'seed') && (typeof parameters.seed !== 'number' || !Number.isSafeInteger(parameters.seed))) {
    invalid('parameters.seed', 'Seed must be a safe integer')
  }
  if (Object.hasOwn(parameters, 'generateAudio') && typeof parameters.generateAudio !== 'boolean') {
    invalid('parameters.generateAudio', 'Audio option must be boolean')
  }
  return frozenCopy(value as unknown as GenerationInput)
}

export function assertCapabilityDefinition(capability: Capability): void {
  if (!isNonBlank(capability.id) || !MODES.includes(capability.mode)) invalid('capability', 'Invalid capability identity')
  if (!['required', 'optional', 'unsupported'].includes(capability.prompt)) invalid('capability.prompt', 'Invalid Prompt policy')
  if (capability.mode === 'text-to-video' && capability.prompt !== 'required') {
    invalid('capability.prompt', 'Text-to-video always requires a Prompt')
  }
  if (!capability.durationSeconds.length || capability.durationSeconds.some(n => !Number.isSafeInteger(n) || n <= 0)) {
    invalid('capability.durationSeconds', 'Expected positive integer durations')
  }
  if (!capability.resolutions.length || capability.resolutions.some(r => !isNonBlank(r))) {
    invalid('capability.resolutions', 'Expected non-empty resolutions')
  }
  const options = capability.optionalParameters
  if (!isRecord(options)) invalid('capability.optionalParameters', 'Expected optional parameter constraints')
  keys(options, ['aspectRatios', 'seedRange', 'generateAudio'], 'capability.optionalParameters')
  if (options.aspectRatios && (!options.aspectRatios.length || options.aspectRatios.some(r => !isNonBlank(r)))) {
    invalid('capability.aspectRatios', 'Expected non-empty aspect ratios')
  }
  if (options.seedRange && (!Number.isSafeInteger(options.seedRange.min)
    || !Number.isSafeInteger(options.seedRange.max) || options.seedRange.min > options.seedRange.max)) {
    invalid('capability.seedRange', 'Invalid seed range')
  }
  if (options.generateAudio && (!options.generateAudio.length || options.generateAudio.some(b => typeof b !== 'boolean'))) {
    invalid('capability.generateAudio', 'Expected boolean audio options')
  }
}

/** 同时用于模型和实际 Route；不会静默丢弃不支持的参数。 */
export function assertInputMatchesCapability(input: GenerationInput, capability: Capability): void {
  if (input.mode !== capability.mode) invalid('mode', 'Mode is unsupported by this capability')
  if (capability.prompt === 'required' && !isNonBlank(input.prompt)) invalid('prompt', 'This capability requires a Prompt')
  if (capability.prompt === 'unsupported' && input.prompt !== undefined) invalid('prompt', 'Prompt is unsupported')
  const parameters = input.parameters
  if (!capability.durationSeconds.includes(parameters.durationSeconds)) invalid('parameters.durationSeconds', 'Unsupported duration')
  if (!capability.resolutions.includes(parameters.resolution)) invalid('parameters.resolution', 'Unsupported resolution')
  const options = capability.optionalParameters
  if (parameters.aspectRatio !== undefined && !options.aspectRatios?.includes(parameters.aspectRatio)) {
    invalid('parameters.aspectRatio', 'Unsupported aspect ratio')
  }
  if (parameters.seed !== undefined && (!options.seedRange || parameters.seed < options.seedRange.min || parameters.seed > options.seedRange.max)) {
    invalid('parameters.seed', 'Unsupported seed')
  }
  if (parameters.generateAudio !== undefined && !options.generateAudio?.includes(parameters.generateAudio)) {
    invalid('parameters.generateAudio', 'Unsupported audio option')
  }
}

/** Route 可以收窄模型能力，不能扩大对外声明。 */
export function assertRouteCapability(model: Capability, route: Capability): void {
  assertCapabilityDefinition(route)
  if (model.id !== route.id || model.mode !== route.mode) invalid('route.capability', 'Route must reference a model capability')
  if (model.prompt !== 'optional' && route.prompt !== model.prompt) invalid('route.prompt', 'Route cannot relax the model Prompt policy')
  if (route.durationSeconds.some(n => !model.durationSeconds.includes(n))) invalid('route.durationSeconds', 'Route expands model durations')
  if (route.resolutions.some(r => !model.resolutions.includes(r))) invalid('route.resolutions', 'Route expands model resolutions')
  const a = model.optionalParameters
  const b = route.optionalParameters
  if (b.aspectRatios?.some(r => !a.aspectRatios?.includes(r))) invalid('route.aspectRatios', 'Route expands aspect ratios')
  if (b.generateAudio?.some(v => !a.generateAudio?.includes(v))) invalid('route.generateAudio', 'Route expands audio options')
  if (b.seedRange && (!a.seedRange || b.seedRange.min < a.seedRange.min || b.seedRange.max > a.seedRange.max)) {
    invalid('route.seedRange', 'Route expands seed range')
  }
}
