<script setup lang="ts">
import { initialFieldValues, validateTemplateFields, type TemplateFieldValues } from '~~/shared/template-form'
import type { TemplateGenerationOptions, TemplateInputField } from '~~/shared/templates'

const props = defineProps<{
  fields: readonly TemplateInputField[]
  options: TemplateGenerationOptions
}>()

const values = reactive<TemplateFieldValues>(initialFieldValues(props.fields))
const errors = ref<Record<string, string>>({})
const checked = ref(false)

const durationLabel = computed(() => `${props.options.duration} seconds`)

function onSubmit() {
  const next = validateTemplateFields(props.fields, values)
  errors.value = next
  checked.value = Object.keys(next).length === 0
  if (checked.value) return
  const first = props.fields.find(field => next[field.key])
  if (first) document.getElementById(`field-${first.key}`)?.focus()
}

function onInput(key: string) {
  checked.value = false
  if (errors.value[key]) {
    errors.value = Object.fromEntries(Object.entries(errors.value).filter(([field]) => field !== key))
  }
}

</script>

<template>
  <form class="tpl-generator" novalidate aria-labelledby="generator-title" data-testid="generator" @submit.prevent="onSubmit">
    <h2 id="generator-title" class="tpl-sr">Create your video</h2>
    <section v-for="(field, index) in fields" :key="field.key" class="tpl-step">
      <h3>
        <span class="tpl-step-index">{{ index + 1 }}</span>
        {{ field.label }}
      </h3>
      <textarea
        v-if="field.type === 'textarea'"
        :id="`field-${field.key}`"
        v-model="values[field.key]"
        class="tpl-input tpl-textarea"
        :placeholder="field.placeholder"
        :maxlength="field.maxLength"
        :aria-required="field.required"
        :aria-invalid="Boolean(errors[field.key])"
        :aria-describedby="errors[field.key] ? `error-${field.key}` : undefined"
        rows="4"
        @input="onInput(field.key)"
      />
      <select
        v-else-if="field.type === 'select'"
        :id="`field-${field.key}`"
        v-model="values[field.key]"
        class="tpl-input"
        :aria-required="field.required"
        :aria-invalid="Boolean(errors[field.key])"
        :aria-describedby="errors[field.key] ? `error-${field.key}` : undefined"
        @change="onInput(field.key)"
      >
        <option v-if="!field.required" value="">No preference</option>
        <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <input
        v-else
        :id="`field-${field.key}`"
        v-model="values[field.key]"
        class="tpl-input"
        type="text"
        :placeholder="field.placeholder"
        :maxlength="field.maxLength"
        :aria-required="field.required"
        :aria-invalid="Boolean(errors[field.key])"
        :aria-describedby="errors[field.key] ? `error-${field.key}` : undefined"
        @input="onInput(field.key)"
      >
      <p v-if="errors[field.key]" :id="`error-${field.key}`" class="tpl-error" role="alert">{{ errors[field.key] }}</p>
    </section>

    <section class="tpl-step" aria-label="Preset format">
      <h3>
        <span class="tpl-step-index">{{ fields.length + 1 }}</span>
        Format
      </h3>
      <div class="tpl-presets">
        <p><span>Aspect ratio</span><strong>{{ options.aspectRatio }}</strong></p>
        <p><span>Duration</span><strong>{{ durationLabel }}</strong></p>
      </div>
    </section>

    <button class="tpl-btn" type="submit" data-testid="generate" aria-describedby="generator-availability">
      Generate video
      <span class="tpl-btn-note">Not open yet</span>
    </button>
    <p id="generator-availability" class="tpl-availability" role="status">
      Video generation is not open yet. This button only checks the fields. It does not create a video or use credits.
    </p>
    <p v-if="checked" class="tpl-checked" data-testid="generation-closed" role="status">
      These fields check out. They stay in this browser. Nothing was sent.
    </p>
  </form>
</template>
