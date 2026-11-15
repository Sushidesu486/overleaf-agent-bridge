"""Add email registration and use the configured site name in native navigation."""
from pathlib import Path

ROOT = Path('/overleaf/services/web')


def replace(name, old, new):
    path = ROOT / name
    source = path.read_text()
    if source.count(old) != 1:
        raise SystemExit('Site patch context mismatch: ' + name)
    path.write_text(source.replace(old, new))


replace('config/settings.defaults.js', "    'user-activate',\n",
        "    'user-activate',\n    'site-access',\n")
replace('app/src/infrastructure/Features.mjs',
        "      case 'registration-page':\n        return (",
        "      case 'registration-page':\n        return process.env.SITE_SELF_REGISTRATION === 'true' && (")
replace('app/views/user/register.pug',
        (ROOT / 'app/views/user/register.pug').read_text(),
        'extends ../../../modules/site-access/app/views/register\n')
replace('app/views/user/login.pug', "\t\t\t\t\t\tif login_support_text\n",
        "\t\t\t\t\t\tif settings.siteAccess.registration\n"
        "\t\t\t\t\t\t\thr\n"
        "\t\t\t\t\t\t\tp.text-center\n"
        "\t\t\t\t\t\t\t\t| Need an account? \n"
        "\t\t\t\t\t\t\t\ta(href='/register') Register with email\n"
        "\t\t\t\t\t\tif login_support_text\n")

logo = 'frontend/js/shared/components/sidebar/ds-nav-overleaf-logo.tsx'
replace(logo, "import { useActiveOverallTheme } from '@/shared/hooks/use-active-overall-theme'\n", '')
replace(logo, "import overleafLogo from '@/shared/svgs/overleaf-a-ds-solution-mallard.svg'\n", '')
replace(logo, "import overleafLogoDark from '@/shared/svgs/overleaf-a-ds-solution-mallard-dark.svg'\n", '')
replace(logo, '  const activeOverallTheme = useActiveOverallTheme()\n', '')
replace(logo, '''        <img
          src={activeOverallTheme === 'dark' ? overleafLogoDark : overleafLogo}
          alt="Overleaf, A Digital Science Solution"
          height="59"
          width="130"
        />''', '        <span className="site-name-wordmark">{appName}</span>')

toolbar = 'frontend/js/features/ide-react/components/toolbar/logos.tsx'
replace(toolbar, "import OLTooltip", "import getMeta from '@/utils/meta'\nimport OLTooltip")
replace(toolbar, "  const { t } = useTranslation()", "  const { t } = useTranslation()\n  const appName = getMeta('ol-ExposedSettings')?.appName ?? 'Overleaf'")
replace(toolbar, '<div className="ide-redesign-toolbar-home-button">', '<div className="ide-redesign-toolbar-home-button site-toolbar-home">')
replace(toolbar, '<span className="toolbar-ol-logo" aria-label={t(\'overleaf_logo\')} />', '<span className="site-toolbar-name">{appName}</span>')
replace('frontend/stylesheets/main-style.scss', "@import 'ciam/all';",
        "@import 'ciam/all';\n@import '../../modules/site-access/public/site';")

replace('frontend/js/features/settings/components/root.tsx',
        "import LinkingSection from './linking-section'",
        "import LinkingSection from './linking-section'\n"
        "import GitHubAccount from '../../../../../modules/agent-access/frontend/js/components/github-account'")
replace('frontend/js/features/settings/components/root.tsx',
        '          </SSOProvider>\n',
        '          </SSOProvider>\n          <GitHubAccount />\n')

# Native CE loads adjacent precompiled JS before consulting the Pug source.
# These two templates must be compiled from the updated source at boot.
for name in ['app/views/user/login.js', 'app/views/user/register.js']:
    (ROOT / name).unlink(missing_ok=True)
