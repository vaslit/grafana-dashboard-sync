# Использование Grafana Dashboard Sync

Этот документ описывает практическую работу с расширением `Grafana Dashboard Sync` в VS Code.

## Что Делает Плагин

Плагин помогает:

- хранить Grafana dashboards в git
- делать `pull` из dev Grafana
- управлять ревизиями дашбордов
- задавать target-specific overrides
- настраивать datasource mappings
- выполнять `render` для конкретных targets
- делать `deploy` и `backup`
- выгружать alerts (rules + contact points) по target

Основная идея:

- локальный проект хранит source dashboards и историю ревизий
- `pull` разрешен только из `dev target`
- `render` и `deploy` выполняются уже в контексте выбранного target

## Основные Понятия

- `Instance`:
  логическое подключение к Grafana organization или серверу
- `Target`:
  конкретная среда внутри instance, например `dev`, `test`, `prod`
- `Dev Target`:
  единственный target, из которого разрешен `pull`
- `Active Target`:
  target, относительно которого работают многие команды из дерева `Dashboards`
- `Revision`:
  сохраненный snapshot дашборда
- `Working Copy`:
  локально checkout-нутая ревизия файла в проекте

## Структура Проекта

Поддерживается только текущий layout:

```text
project-root/
  .grafana-dashboard-workspace.json
  dashboards/
  backups/
  renders/
  alerts/   # появится после первого Pull Alerts
```

Важно:

- отдельная filesystem-based папка `instances/` больше не используется
- instances, targets, dashboards и datasource mappings хранятся в `.grafana-dashboard-workspace.json`
- path для alerts тоже задается там, через `layout.alertsDir`
- `GRAFANA_URL`, `GRAFANA_URL_FALLBACKS` и `GRAFANA_USERNAME` сохраняются в config файла проекта
- token и password хранятся в VS Code Secret Storage

## Быстрый Старт

1. Открой папку проекта в VS Code.
2. Выполни `Grafana Sync: Initialize Grafana Dashboard Project`.
3. В дереве `Instances` создай instance:
   - `Grafana Sync: Create Instance`
4. Для instance задай `GRAFANA_URL` в `Details > Instance`.
   При необходимости укажи `GRAFANA_URL_FALLBACKS` по одному URL на строку.
5. Настрой аутентификацию instance:
   - либо `Grafana Sync: Set Instance Token`
   - либо укажи `GRAFANA_USERNAME` и сохрани пароль командой `Grafana Sync: Set Instance Password`
6. Создай deployment target:
   - `Grafana Sync: Create Deployment Target`
7. Выбери dev target:
   - `Grafana Sync: Select Dev Target`
8. Добавь дашборд в проект:
   - `Grafana Sync: Add Dashboard`
9. Выполни `pull`:
   - для одного dashboard: `Grafana Sync: Pull Dashboard From Dev Target`
   - для всех dashboards: `Grafana -> Instances -> Dev Target -> Pull All Dashboards From Dev Target`

## Ежедневный Workflow

Обычный цикл работы выглядит так:

1. Изменить дашборд в dev Grafana.
2. Выполнить `pull`:
   - одного dashboard через `Dashboards`
   - или всех dashboards через `Instances -> Dev Target`
3. Проверить или обновить:
   - datasource mappings
   - variable overrides
   - folder placement
   - target-specific dashboard UID
4. Выполнить `render` для нужных targets.
5. При необходимости выполнить `Grafana Sync: Pull Alerts` для нужного target.
6. Проверить render output и pulled alerts.
7. Закоммитить изменения в git.

## Практическая Карта Действий

Ниже описано, из какого раздела UI что именно выполняется.

### Разделы UI

- `Grafana -> Dashboards`
  список managed dashboards и их revisions
- `Grafana -> Instances`
  список instances, targets и dashboards внутри target
- `Grafana -> Details`
  просмотр и редактирование manifest, instance config, overrides, datasource mappings, target dashboard status

### Pull Dashboard

Как забрать изменения из dev Grafana в локальный проект:

- Раздел: `Grafana -> Dashboards`
- Внутри: выбрать dashboard
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Pull Dashboard From Dev Target`

Или:

- Раздел: `Grafana -> Instances`
- Внутри: выбрать item `Dev Target`
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Pull All Dashboards From Dev Target`

Важно:

- `pull` dashboards всегда идет только из `dev target`
- поэтому в `Instances` команда массового `pull` теперь находится только на item `Dev Target`

### Checkout Revision

Как сделать старую revision локальной рабочей копией:

- Раздел: `Grafana -> Dashboards`
- Внутри: раскрыть dashboard -> выбрать revision
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Checkout Revision`

Что происходит:

- локальный dashboard JSON заменяется snapshot этой revision
- эта revision становится `checked out`
- target-и при этом не меняются

### Set Revision On Active Target

Как назначить revision текущей для target без deploy:

- Раздел: `Grafana -> Dashboards`
- Внутри: раскрыть dashboard -> выбрать revision
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Set Revision On Active Target`

Что происходит:

- выбранная revision записывается как `current revision` для `active target`
- deploy в Grafana не выполняется

Важно:

- если `active target` уже выбран, используется он
- если `active target` не выбран, откроется выбор одного target

Для массового назначения одной revision:

- Раздел: `Grafana -> Dashboards`
- Внутри: раскрыть dashboard -> выбрать revision
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Set Revision On Targets...`

Дальше откроется scope picker:

- `Current Active Target`
- `Targets...`
- `All Targets In Active Instance`
- `All Targets`

### Deploy Конкретной Revision Из Истории

Как сразу раскатить конкретную revision:

- Раздел: `Grafana -> Dashboards`
- Внутри: раскрыть dashboard -> выбрать revision
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Deploy Revision To Active Target`

Что происходит:

- эта revision становится `current revision` для target
- затем сразу деплоится в Grafana

Это правильный путь, если нужно раскатить не текущую локальную версию, а конкретную revision из истории.

Для массового deploy одной revision:

- Раздел: `Grafana -> Dashboards`
- Внутри: раскрыть dashboard -> выбрать revision
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Deploy Revision On Targets...`

Дальше откроется scope picker:

- `Current Active Target`
- `Targets...`
- `All Targets In Active Instance`
- `All Targets`

### Deploy Checked Out / Локальной Версии

Как раскатить текущую локальную working copy:

- Раздел: `Grafana -> Dashboards`
- Внутри: выбрать dashboard
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Deploy Dashboard`

Дальше откроется scope picker:

- `Current Active Target`
- `All Targets In Active Instance`
- `All Instances`

Что происходит:

- деплоится текущее локальное состояние dashboard
- если локальный файл совпадает с `checked out revision`, то по сути деплоится она
- если локальный файл уже изменен после checkout, деплоится именно измененная working copy

Итог:

- `Dashboards -> Deploy Dashboard` не берет revision с target
- он берет текущий локальный файл

### Deploy Той Revision, Которая Уже Установлена На Target

Прямой отдельной команды сейчас нет.

Нужно сделать так:

1. Открыть `Grafana -> Instances`
2. Выбрать нужный `target`
3. В `Details` найти секцию `Target Dashboards`
4. У нужного dashboard посмотреть поле `Stored revision`
5. Перейти в `Grafana -> Dashboards`
6. Раскрыть этот dashboard
7. Найти revision с этим ID
8. Нажать:
   `ПКМ -> Grafana Sync: Deploy Revision To Active Target`

Это и есть корректный способ повторно задеплоить ту revision, которая сейчас закреплена за target.

### Deploy Из Instances

Как деплоить не локальную working copy, а то, что уже закреплено за target-ами:

#### Deploy одного dashboard в конкретный target

- Раздел: `Grafana -> Instances`
- Внутри: `instance -> target -> dashboard`
- Нажать:
  `inline/context action -> Grafana Sync: Deploy Dashboard`

Что происходит:

- деплоится dashboard в этот конкретный target
- используется revision, закрепленная за этим target

#### Deploy всех dashboards в target

- Раздел: `Grafana -> Instances`
- Внутри: выбрать `target`
- Нажать:
  `inline/context action -> Grafana Sync: Deploy Dashboard`

Что происходит:

- во все dashboards этого target деплоятся их текущие target-specific revisions

#### Deploy всех dashboards во все targets instance

- Раздел: `Grafana -> Instances`
- Внутри: выбрать `instance`
- Нажать:
  `inline/context action -> Grafana Sync: Deploy Dashboard`

Что происходит:

- для каждого target этого instance деплоятся все dashboards
- в каждом target у каждого dashboard используется его собственная `current revision`

Итог:

- `Instances -> Deploy Dashboard` работает от target state
- `Dashboards -> Deploy Dashboard` работает от локальной working copy

## Datasources

Datasource mappings настраиваются в `Details > Datasources`.

Формат хранения в `.grafana-dashboard-workspace.json`:

```json
{
  "datasources": {
    "integration": {
      "instances": {
        "prod": {
          "uid": "target-ds",
          "name": "Target Datasource"
        }
      }
    }
  }
}
```

Основной сценарий:

- выбрать datasource из списка, если target Grafana доступен

План Б:

- вручную ввести `Target Datasource Name`
- вручную ввести `Target Datasource UID`

Это полезно, если:

- target недоступен разработчику
- auto-resolve datasource не сработал
- значение известно заранее из production/test Grafana

Важно:

- для успешного target-specific `render` обычно нужен именно `uid`
- одно имя datasource можно сохранить как metadata, но без `uid` render может завершиться ошибкой, если mapping неразрешим

## Overrides

В `Details > Overrides` можно управлять поддерживаемыми dashboard variables:

- `custom`
- `textbox`
- `constant`

Override сохраняется не глобально, а для конкретной revision выбранного target.

Если меняется только значение managed override variable при `pull`, новая revision обычно не создается.

## Placement

В `Details > Placement` можно настроить:

- target-specific folder path
- target-specific dashboard UID

Это нужно, когда один и тот же dashboard должен жить по-разному на разных targets.

Новый workflow:

- `folderPath` можно ввести вручную
- под полем есть встроенный browser по папкам Grafana
- browser показывает текущий уровень, `..` для перехода вверх и вложенные папки
- `OK` только подставляет путь в поле
- фактическое сохранение делает кнопка `Save Placement`

Если target Grafana недоступен:

- ручной ввод path все равно остается доступным
- сохранение path не блокируется только из-за того, что такой папки сейчас не видно в Grafana

## Render

Основные команды:

- `Grafana Sync: Render Dashboard`
- `Grafana Sync: Render Target`
- `Grafana Sync: Render Instance`
- `Grafana Sync: Render All Instances`
- `Grafana Sync: Open Render Folder`

### Render текущей локальной working copy одного dashboard

- Раздел: `Grafana -> Dashboards`
- Внутри: выбрать dashboard
- Нажать:
  `ПКМ / context menu -> Grafana Sync: Render Dashboard`

Дальше откроется scope picker:

- `Current Active Target`
- `All Targets In Active Instance`
- `All Instances`

Что происходит:

- рендерится текущее локальное состояние dashboard
- как и у `Dashboards -> Deploy Dashboard`, основой является локальная working copy

### Render всех dashboards в конкретный target

- Раздел: `Grafana -> Instances`
- Внутри: выбрать `target`
- Нажать:
  `inline/context action -> Grafana Sync: Render Target`

Что происходит:

- рендерятся все dashboards для этого target
- для каждого dashboard используется revision, закрепленная за target

### Render всех dashboards во все targets instance

- Раздел: `Grafana -> Instances`
- Внутри: выбрать `instance`
- Нажать:
  `inline/context action -> Grafana Sync: Render Instance`

Что происходит:

- рендерятся все dashboards во все targets этого instance
- в каждом target у каждого dashboard используется его собственная `current revision`

### Render всех dashboards во всех instances

- Раздел: `Grafana -> Instances`
- Нажать в заголовке view:
  `Grafana Sync: Render All Instances`

Что происходит:

- рендерятся все dashboards во все targets всех instances

### Где лежит результат render

```text
renders/<instance>/<target>/
```

Render использует:

- текущую revision target
- datasource mappings
- variable overrides
- placement overrides

Итог:

- `Dashboards -> Render Dashboard` работает от локальной working copy
- `Instances -> Render Target / Render Instance / Render All Instances` работает от revision, закрепленных за target-ами

## Alerts Pull

Команда:

- `Grafana Sync: Pull Alerts`

Что делает:

- загружает список rule из Grafana и дает выбрать конкретные alerts
- для выбранных alerts сохраняет сами rules и связанные `contact points` (по прямому receiver)
- сохраняет pretty JSON (читаемый diff)

Куда сохраняет:

```text
alerts/<instance>/<target>/
  manifest.json
  rules/<alert-uid>.json
  contact-points/<contact-point-key>.json
```

Важно:

- `Pull Alerts` не ограничен `dev target` (в отличие от `pull` dashboards)
- связь alert -> contact point в v1 только прямая (без полного resolve по policies)
- для alert без прямого receiver в details будет статус `policy-managed`

## Deploy Alert

Команда:

- `Grafana Sync: Deploy Alert`

Что делает:

- загружает выбранный локальный alert обратно в Grafana
- перед upload сравнивает локальную и текущую remote-версию
- если отличий нет, upload пропускается
- если alert связан с локальными contact points, они тоже upsert-ятся

## Deploy

Основные команды:

- `Grafana Sync: Deploy Dashboard`
- `Grafana Sync: Deploy All Dashboards`

Для revision из дерева:

- `Grafana Sync: Deploy Revision To Active Target`

Рекомендуемый процесс для shared environments:

- разработчик делает `render`
- итоговые файлы попадают в git
- официальный deploy выполняется через GitLab

## Backups

Плагин умеет создавать и восстанавливать raw backups.

Основные команды:

- `Grafana Sync: Create Backup`
- `Grafana Sync: Create Backup of All Dashboards`
- `Grafana Sync: Restore Backup`

Backups особенно полезны перед deploy или перед массовыми изменениями.

## Recommended Access Model

Практичная схема работы:

- у разработчика есть рабочий доступ в `dev`
- у разработчика есть `read-only` token в `prod`
- у GitLab есть `write` token для `test` и `prod`

Это позволяет:

- делать `pull` из dev
- заранее видеть datasource metadata из prod
- выполнять локальный `render` для `test/prod`
- не давать разработчику случайно делать ручной deploy в shared environments

## Аутентификация Instance

Поддерживаются два режима:

- bearer token
- basic auth через `GRAFANA_USERNAME` и пароль

Практические правила:

- если у instance сохранен token, плагин использует его
- если token не задан, но сохранены `GRAFANA_USERNAME` и пароль, плагин использует basic auth
- пароль хранится в VS Code Secret Storage
- `GRAFANA_URL`, fallback URLs и username хранятся в `.grafana-dashboard-workspace.json`

Команды:

- `Grafana Sync: Set Instance Token`
- `Grafana Sync: Clear Instance Token`
- `Grafana Sync: Set Instance Password`
- `Grafana Sync: Clear Instance Password`

## Типовые Ошибки

`Datasource mappings are missing`

- для target не разрешен datasource `uid`
- открой `Details > Datasources`
- выбери datasource из списка или введи `name` и `uid` вручную

`Pull is allowed only from dev target`

- выбран не тот target
- сначала выполни `Grafana Sync: Select Dev Target`

`Current revision is not set`

- для target еще не назначена ревизия
- выбери revision через `Grafana Sync: Set Revision On Active Target`

## Где Смотреть Дальше

- общий обзор проекта: [README.md](README.md)
- процесс разработки и поставки: [DEVELOPMENT_AND_DELIVERY.md](DEVELOPMENT_AND_DELIVERY.md)
- локальная сборка: [LOCAL_BUILD.md](LOCAL_BUILD.md)
