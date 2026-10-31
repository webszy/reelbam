<script setup lang="ts">
import type { TemplateView } from '~~/shared/template-view'

defineProps<{ view: TemplateView }>()

const featureIcons = ['type', 'film', 'phone', 'clock', 'shield', 'spark'] as const
</script>

<template>
  <div class="tpl" data-testid="template-landing">
    <section class="tpl-hero">
      <div class="tpl-hero-glow" aria-hidden="true" />
      <div class="tpl-wrap tpl-hero-grid">
        <div id="create" class="tpl-hero-copy">
          <nav class="tpl-crumbs" aria-label="Breadcrumb">
            <ol>
              <li><NuxtLink to="/">Home</NuxtLink></li>
              <li><NuxtLink to="/templates">Templates</NuxtLink></li>
              <li aria-current="page">{{ view.template.title }}</li>
            </ol>
          </nav>
          <h1>{{ view.page.h1 }}</h1>
          <p class="tpl-lede">{{ view.page.subtitle }}</p>
          <TemplateGeneratorForm :fields="view.template.inputFields" :options="view.template.generationOptions" />
        </div>
        <div class="tpl-hero-side">
          <p class="tpl-chip tpl-chip-badge"><TemplateMark name="flame" class="tpl-icon" /> {{ view.page.badge }}</p>
          <div class="tpl-samples" :class="{ 'is-single': view.page.samples.length === 1, 'is-pair': view.page.samples.length === 2 }">
            <TemplateVideoCard
              v-for="sample in view.page.samples"
              :key="sample.videoUrl + sample.label"
              :video="sample.videoUrl"
              :poster="sample.posterUrl"
              :label="sample.label"
              :credit="sample.credit"
            />
          </div>
          <div class="tpl-chips">
            <span v-for="chip in view.page.chips" :key="chip" class="tpl-chip">{{ chip }}</span>
          </div>
          <p class="tpl-note">{{ view.page.sampleNote }}</p>
        </div>
      </div>
    </section>

    <section v-if="view.page.problem" id="problem" class="tpl-section">
      <div class="tpl-wrap">
        <p class="tpl-eyebrow">{{ view.page.problem.eyebrow }}</p>
        <h2>{{ view.page.problem.title }}</h2>
        <div class="tpl-cards tpl-cards-3">
          <article v-for="item in view.page.problem.items" :key="item.title" class="tpl-card">
            <h3>{{ item.title }}</h3>
            <p>{{ item.body }}</p>
          </article>
        </div>
      </div>
    </section>

    <section v-if="view.page.compare" id="compare" class="tpl-section tpl-band">
      <div class="tpl-wrap tpl-narrow">
        <p class="tpl-eyebrow">{{ view.page.compare.eyebrow }}</p>
        <h2>{{ view.page.compare.title }}</h2>
        <div class="tpl-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{{ view.page.compare.withoutLabel }}</th>
                <th scope="col">{{ view.page.compare.withLabel }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in view.page.compare.rows" :key="row.with">
                <td><span class="tpl-cell"><TemplateMark name="x" class="tpl-icon tpl-icon-no" /> {{ row.without }}</span></td>
                <td><span class="tpl-cell"><TemplateMark name="check" class="tpl-icon tpl-icon-yes" /> {{ row.with }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="how-it-works" class="tpl-section">
      <div class="tpl-wrap">
        <p class="tpl-eyebrow">{{ view.page.howTo.eyebrow }}</p>
        <h2>{{ view.page.howTo.title }}</h2>
        <ol class="tpl-cards tpl-cards-3 tpl-steps">
          <li v-for="(step, index) in view.page.howTo.steps" :key="step.title" class="tpl-card">
            <span class="tpl-numeral">{{ index + 1 }}</span>
            <h3>{{ step.title }}</h3>
            <p>{{ step.body }}</p>
          </li>
        </ol>
        <a class="tpl-btn tpl-btn-inline" href="#create">{{ view.page.howTo.cta }}</a>
      </div>
    </section>

    <section id="examples" class="tpl-section tpl-band">
      <div class="tpl-wrap tpl-split">
        <div>
          <p class="tpl-eyebrow">{{ view.page.showcase.eyebrow }}</p>
          <h2>{{ view.page.showcase.title }}</h2>
          <p class="tpl-lede">{{ view.page.showcase.body }}</p>
        </div>
        <div v-if="view.page.samples[0]" class="tpl-before-after">
          <figure class="tpl-script">
            <pre>{{ view.page.showcase.beforeText }}</pre>
            <figcaption>{{ view.page.showcase.beforeLabel }}</figcaption>
          </figure>
          <TemplateMark name="arrow" class="tpl-icon tpl-arrow" />
          <div>
            <TemplateVideoCard
              :video="view.page.samples[0].videoUrl"
              :poster="view.page.samples[0].posterUrl"
              :label="view.page.samples[0].label"
            />
            <p class="tpl-caption">{{ view.page.showcase.afterLabel }}</p>
          </div>
        </div>
      </div>
    </section>

    <section id="about" class="tpl-section">
      <div class="tpl-wrap tpl-prose">
        <p class="tpl-eyebrow">{{ view.page.about.eyebrow }}</p>
        <h2>{{ view.page.about.title }}</h2>
        <p v-for="paragraph in view.page.about.paragraphs" :key="paragraph">{{ paragraph }}</p>
      </div>
    </section>

    <section id="features" class="tpl-section">
      <div class="tpl-wrap">
        <p class="tpl-eyebrow">{{ view.page.features.eyebrow }}</p>
        <h2>{{ view.page.features.title }}</h2>
        <div class="tpl-cards tpl-cards-features">
          <article v-for="(item, index) in view.page.features.items" :key="item.title" class="tpl-card">
            <span class="tpl-feature-icon"><TemplateMark :name="featureIcons[index % featureIcons.length] ?? 'spark'" class="tpl-icon" /></span>
            <h3>{{ item.title }}</h3>
            <p>{{ item.body }}</p>
          </article>
        </div>
      </div>
    </section>

    <section v-if="view.page.scenes" id="scenes" class="tpl-section">
      <div class="tpl-wrap">
        <p class="tpl-eyebrow">{{ view.page.scenes.eyebrow }}</p>
        <h2>{{ view.page.scenes.title }}</h2>
        <div class="tpl-scenes">
          <article v-for="(scene, index) in view.page.scenes.items" :key="scene.title" class="tpl-scene">
            <div v-if="scene.sample" class="tpl-scene-media">
              <TemplateVideoCard :video="scene.sample.videoUrl" :poster="scene.sample.posterUrl" :label="scene.sample.label" :credit="scene.sample.credit" />
            </div>
            <div class="tpl-scene-copy" :class="{ 'is-wide': !scene.sample }">
              <span class="tpl-numeral">0{{ index + 1 }}</span>
              <h3>{{ scene.title }}</h3>
              <p>{{ scene.body }}</p>
              <a class="tpl-text-link" href="#create">{{ view.page.scenes.cta }} <TemplateMark name="arrow" class="tpl-icon" /></a>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section id="faq" class="tpl-section">
      <div class="tpl-wrap tpl-faq">
        <div>
          <h2>{{ view.page.faq.title }}</h2>
          <p>{{ view.page.faq.body }}</p>
          <NuxtLink class="tpl-btn tpl-btn-inline tpl-btn-ghost" to="/pricing">See credit packs</NuxtLink>
        </div>
        <div class="tpl-faq-list">
          <details v-for="item in view.page.faq.items" :key="item.q">
            <summary>
              {{ item.q }}
              <TemplateMark name="plus" class="tpl-icon tpl-plus" />
            </summary>
            <p>{{ item.a }}</p>
          </details>
        </div>
      </div>
    </section>

    <section v-if="view.related.length" id="related" class="tpl-section tpl-band">
      <div class="tpl-wrap">
        <p class="tpl-eyebrow">More templates</p>
        <h2>Related templates</h2>
        <ul class="tpl-related">
          <li v-for="item in view.related" :key="item.id">
            <NuxtLink :to="`/templates/${item.slug}`">
              <img :src="item.posterUrl" alt="" width="720" height="1280">
              <span>{{ item.category }}</span>
              <strong>{{ item.title }}</strong>
            </NuxtLink>
          </li>
        </ul>
      </div>
    </section>

    <section class="tpl-section tpl-final-wrap">
      <div class="tpl-wrap">
        <div class="tpl-final">
          <h2>{{ view.page.finalCta.title }}</h2>
          <p>{{ view.page.finalCta.body }}</p>
          <a class="tpl-btn tpl-btn-inline tpl-btn-inverse" href="#create">{{ view.page.finalCta.cta }}</a>
        </div>
      </div>
    </section>
  </div>
</template>
