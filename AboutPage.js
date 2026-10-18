export default {
  emits: ['go-home', 'navigate'],

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
        <div class="subpage-nav">
          <button class="subpage-back" @click="$emit('go-home')">
            <span class="material-icons">arrow_back</span>
          </button>
          <div class="valu-orb-sm subpage-orb">
            <div class="spheres">
              <div class="spheres-group">
                <div class="sphere s1"></div>
                <div class="sphere s2"></div>
                <div class="sphere s3"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="subpage-header">
          <h1 class="subpage-title">About</h1>
        </div>

        <div style="padding:0 16px 24px;">
          <div class="card mb-16">
            <div class="card-body">
              <p style="font-size:14px;line-height:1.6;color:var(--color-text);">
                <strong>Valu Groceries</strong> keeps your shopping lists simple, private and always at hand.
              </p>
              <p style="font-size:14px;line-height:1.6;color:var(--color-text-secondary);margin-top:8px;">
                Plan what you need per store, tick items off as you shop, and optionally keep track of what you spend,
                also when you shop in another currency. Everything is stored in your own Google Drive.
              </p>
            </div>
          </div>

          <div class="card mb-16">
            <div class="card-header"><h3>Privacy</h3></div>
            <div class="card-body">
              <p style="font-size:14px;line-height:1.6;color:var(--color-text-secondary);">
                Your lists are stored exclusively in Google Sheets on your own Google Drive. Valu Groceries never sends them to any external server.
                The app runs entirely in your browser.
              </p>
            </div>
          </div>

          <div class="card mb-16">
            <div class="card-header"><h3>How it works</h3></div>
            <div class="card-body">
              <div class="about-feature">
                <span class="material-icons about-feature-icon">folder</span>
                <div>
                  <strong>Your data, your Drive</strong>
                  <p style="font-size:14px;color:var(--color-text-secondary);margin-top:2px;">
                    Each group is a spreadsheet in your Google Drive. You own and control it.
                  </p>
                </div>
              </div>
              <div class="about-feature">
                <span class="material-icons about-feature-icon">storefront</span>
                <div>
                  <strong>A list per store</strong>
                  <p style="font-size:14px;color:var(--color-text-secondary);margin-top:2px;">
                    Keep the lists of the shops you visit apart, and reorder them to match the aisles.
                  </p>
                </div>
              </div>
              <div class="about-feature">
                <span class="material-icons about-feature-icon">currency_exchange</span>
                <div>
                  <strong>Any currency</strong>
                  <p style="font-size:14px;color:var(--color-text-secondary);margin-top:2px;">
                    Enter a price in a foreign currency and it is converted to your base currency with the exchange rate of the day.
                  </p>
                </div>
              </div>
              <div class="about-feature">
                <span class="material-icons about-feature-icon">people</span>
                <div>
                  <strong>Shared lists</strong>
                  <p style="font-size:14px;color:var(--color-text-secondary);margin-top:2px;">
                    Share the Google Sheet with someone and you both shop from the same list.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
