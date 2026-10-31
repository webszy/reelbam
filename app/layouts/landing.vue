<template>
  <div class="revolver-landing">
    <header class="landing-nav">
      <NuxtLink class="landing-brand" to="/">reelbam</NuxtLink>
      <nav class="landing-links" aria-label="Main">
        <NuxtLink to="/templates">Templates</NuxtLink>
        <NuxtLink to="/pricing">Pricing</NuxtLink>
        <div class="landing-auth">
          <AuthActions />
        </div>
      </nav>
    </header>
    <slot />
  </div>
</template>
