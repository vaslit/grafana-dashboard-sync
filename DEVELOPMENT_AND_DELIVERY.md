# Процесс Разработки И Доставки Grafana Dashboards

Этот документ описывает рекомендуемый процесс разработки, ревью, тестирования и доставки Grafana dashboards с использованием `Grafana Dashboard Sync`.

## 1. Целевая Схема Окружений

Рекомендуемая модель:

- `dev org -> git/GitLab -> test/prod в prod org`
- Разные Grafana organizations моделируются в плагине как разные `instances`.
- Для каждой organization используется свой service account и свой token.

Рекомендуемая схема instances в плагине:

| Instance в плагине | Grafana organization | Targets | Назначение |
| --- | --- | --- | --- |
| `dev` | организация разработки | `dev` | источник истины для `pull` и ежедневной разработки |
| `prod` | продуктивная организация | `test`, `prod` | общее тестирование до merge и продуктивная поставка |

Ключевые правила:

- `dev target` является единственным допустимым источником для `pull`
- `test` и `prod` живут внутри одной продуктивной organization
- отдельная третья organization для `test` не требуется

Рекомендуемая модель доступа:

- у разработчиков есть рабочий доступ в `dev org`
- у разработчиков есть `read-only` token для `prod org`
- у GitLab есть отдельный `write` token для deploy в `test` и `prod`

## 2. Роли Инструментов

### VS Code Extension

Расширение является инструментом разработки. Оно отвечает за:

- `pull` дашбордов из `dev target`
- управление ревизиями в git
- управление target-specific overrides
- управление datasource mappings
- `render` target-specific артефактов дашбордов
- чтение metadata из `prod org` при наличии `read-only` token

Расширение не является основным механизмом релизной поставки в общие среды.

При рекомендуемой модели доступа расширение используется для:

- локального `render` для `test` и `prod`
- автоматического чтения списка datasource и folder metadata из `prod org`
- ранней проверки target-specific настроек до открытия MR

Ручной deploy из расширения в shared environments при такой схеме обычно технически недоступен, потому что у разработчиков нет `write` token для `prod org`.

### GitLab

GitLab является официальным механизмом доставки в общие среды. Он отвечает за:

- ревью изменений дашбордов в merge request
- показ diff как по исходникам, так и по render-артефактам
- deploy render-набора `test` до merge
- deploy render-набора `prod` после merge
- rollback через повторный deploy более раннего закоммиченного render-набора
- использование отдельного `write` token для `prod org`

Конкретная реализация CI может опираться на любые внутренние scripts или API tooling, но сам процесс остается неизменным: GitLab деплоит закоммиченные render-артефакты.

## 3. Что Хранится В Git

Репозиторий хранит два типа артефактов:

- исходное состояние проекта дашбордов
- render-артефакты для общих deployment targets

В репозитории должны находиться:

- исходные файлы дашбордов и revision metadata, которыми управляет расширение
- target-specific render outputs в `renders/<instance>/<target>/`
- отдельные render-наборы для:
  - `prod/test`
  - `prod/prod`

Правила для merge request:

- изменения исходников коммитятся вместе с обновленными render outputs
- ревьюер должен видеть и логическое изменение дашборда, и финальный target-specific JSON
- если исходники изменились, а render outputs не были обновлены, изменение считается неполным

Подготовка render-артефактов для `prod/test` и `prod/prod` обычно опирается на metadata, считанные из `prod org` через `read-only` token разработчика:

- datasource list и datasource mappings
- folder structure
- при необходимости live read-only проверка текущего состояния target

План Б для datasource:

- если target временно недоступен или datasource не удалось автоматически сопоставить, разработчик может вручную заполнить datasource name и datasource `uid` в интерфейсе расширения
- ручной ввод нужен именно как fallback, а не как основной сценарий
- если известен только `name`, его тоже можно сохранить в проекте, но для успешного локального `render` target-specific `uid` все равно предпочтителен

## 4. Workflow Разработчика

Стандартный workflow автора дашборда:

1. Разработчик вносит изменения в development organization Grafana.
2. Запускает `Pull Dashboard From Dev Target` или `Pull All Managed Dashboards`.
3. Настраивает в плагине `prod instance` с `read-only` token.
4. При необходимости обновляет или проверяет target-specific настройки в проекте:
   - datasource mappings
   - variable overrides
   - folder path
   - target-specific dashboard UID
   - при необходимости вручную вводит datasource name и datasource `uid` в интерфейсе расширения
5. При наличии `read-only` доступа к `prod org` расширение автоматически подтягивает доступные datasource и помогает заранее проверить настройки для `test` и `prod`.
6. Выполняет `render` для обоих общих targets:
   - `prod/test`
   - `prod/prod`
7. Локально просматривает render outputs.
8. Коммитит изменения исходников и оба render-набора.
9. Открывает merge request в GitLab.

Такой подход делает проверенный Git commit единственным источником для shared deployments.

## 5. Workflow Поставки

### До Merge

`test` используется как общая pre-merge среда.

Рекомендуемый flow:

1. Разработчик открывает MR с изменениями исходников и обновленными render outputs.
2. GitLab запускает validation checks.
3. GitLab предоставляет manual deploy job для `test`.
4. Команда деплоит render-набор `prod/test` из коммита этого MR.
5. Тестировщики и ревьюеры проверяют дашборд в общем `test` target.
6. После успешной проверки MR можно merge.

### После Merge

`prod` деплоится только из основной ветки.

Рекомендуемый flow:

1. Одобренный MR merge в `main` или `default` branch.
2. GitLab предоставляет manual deploy job для `prod`.
3. Команда деплоит закоммиченный render-набор `prod/prod` из слитой ветки.

Это делает rollout в production воспроизводимым и привязанным к проверенной истории Git.

Важно:

- GitLab использует свой `write` token, который не хранится у разработчиков локально
- локальный `read-only` token разработчика не должен использоваться для deploy

## 6. Размещение Test Внутри Production Organization

`test` должен жить в production organization, а не в development organization.

Причины:

- проверка идет в контексте production-side Grafana setup
- используется та же organization-level модель plugins и permissions
- не требуется вводить третью organization
- разработчик может безопасно читать metadata через `read-only` token без риска случайного deploy

Требуемая изоляция между `test` и `prod`:

- отдельные deployment targets: `test` и `prod`
- отдельные folder paths
- отдельные target-specific dashboard UIDs
- отдельные datasource mappings при необходимости
- отдельные variable overrides при необходимости

Рекомендуемые соглашения:

- имена targets: `test`, `prod`
- folder paths:
  - `Team/Service/Test`
  - `Team/Service/Prod`
- политика для dashboard UID:
  - production сохраняет стабильный бизнесовый UID
  - test использует target-specific UID, например `<base>-test`

Разные UID обязательны, если версии одного и того же дашборда для `test` и `prod` должны существовать параллельно внутри одной organization.

## 7. Ограничения И Исключения

Ограничения процесса:

- `pull` разрешен только из настроенного `dev target`
- общий `test` не является личной песочницей разработчика
- локальный доступ разработчика к `prod org` должен быть `read-only`
- deploy в `test` и `prod` выполняется GitLab, а не локальной машиной разработчика

Почему `test` не должен жить в `dev org`:

- проверка будет происходить в неправильном organizational context
- размоется граница между authoring и shared verification
- pre-merge тестирование станет менее репрезентативным относительно production

Если в отдельных случаях организации нужен ручной plugin deploy, это должно быть исключением с отдельным временным `write` доступом. Нормальная поставка изменений все равно должна идти через GitLab.

## 8. Rollback

Rollback должен выполняться из GitLab, а не с локальной машины разработчика.

Рекомендуемый flow rollback:

1. Определить ранее известный стабильный Git commit.
2. Повторно использовать или заново запустить GitLab deploy job для соответствующего закоммиченного render-набора.
3. Выполнить deploy этого render-набора в `test` или `prod`, в зависимости от цели отката.

Это сохраняет auditability и удерживает rollback в рамках проверенного состояния репозитория.

## Типовые Сценарии

### Обычное Изменение Дашборда

- изменить дашборд в `dev`
- сделать `pull` из `dev target`
- использовать `read-only` token для `prod org`, чтобы проверить datasource и target metadata
- выполнить `render` для `prod/test` и `prod/prod`
- закоммитить исходники и render outputs
- выполнить deploy в `test` из MR
- после merge выполнить deploy в `prod`

### Изменение Только Overrides

- скорректировать target-specific overrides в проекте
- заново выполнить `render` для затронутых targets
- проверить diff в отрендеренном JSON
- провести deploy через обычный MR и GitLab flow

### Новый Datasource

- добавить или обнаружить datasource в проекте
- считать metadata из `prod org` через `read-only` token
- настроить datasource mappings для `test` и `prod`
- выполнить `render` обоих targets
- проверить `test` deploy до merge

### Параллельное Существование Test И Production В Одной Org

- использовать разные folder paths
- использовать разные UID
- применять target-specific mappings и overrides по необходимости

### Rollback

- выбрать более ранний проверенный commit
- повторно задеплоить его render-набор через GitLab
- не использовать локальную машину как источник rollback
