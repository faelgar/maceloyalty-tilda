(function () {
  // =========================
  // НАСТРОЙКИ (заполняет мерчант)
  // =========================
  const DesignVariant = {
    BLUE: 'blue',
    GREY: 'grey',
    WHITE: 'white',
  };

  const MaceLoyaltySettings = {
    // ОБЯЗАТЕЛЬНО: id компании в Mace Loyalty
    clientId: '9b97860b-aaa8-4e11-ad9b-7f740b412f68',

    // ОБЯЗАТЕЛЬНО: секрет для доступа к API
    secret: 'p4am4v88rd',

    // ОБЯЗАТЕЛЬНО: URL оформления карты (куда отправляем клиента, если карты нет)
    cardIssueURL: 'https://easy-cards.ru:8081/api/v1/cards/f2320b27-1827-4461-9ddc-b2d00b61956b',

    // Опционально: идентификатор оплаты наличными "cash" при котором карта не отображается, можно дополнить другими видами оплаты или оставить переменную пустой
    forbiddenPayment: ['cash'],

    // Опционально: BLUE (по умолчанию), GREY, WHITE
    designVariant: DesignVariant.BLUE,
  };

  const API_HOST = 'https://easy-cards.ru:8081/tilda/api/v1';

  let detectedFontFamily = 'sans-serif';
  let promoField = null;

  const HiddenFields = {
    cardInstanceId: null,
    amount: null,
    type: null,
    companyId: null,
    useBonusAmount: null,
  };

  const MaceLoyaltyState = {
    card: null,
    phone: null,
    mode: null,
    bonusesToDeposit: 0,
    bonusesToWithdrawal: 0,
    totalCashback: 0,
    useBonusAmount: 0,
  };

  // =========================
  // ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
  // =========================
  function logError(msg) {
    console.error('[MaceLoyalty]', msg);
  }

  function logInfo(msg) {
    console.log('[MaceLoyalty]', msg);
  }

  function validateSettings() {
    const { clientId, secret, cardIssueURL } = MaceLoyaltySettings;

    if (!clientId || !secret || !cardIssueURL) {
      logError(
        'Интеграция не активна: отсутствуют обязательные настройки (clientId, secret, cardIssueURL).'
      );
      return false;
    }

    return true;
  }

  // =========================
  // ПРОВЕРКА ГОТОВНОСТИ DOM / TILDA
  // =========================
  function isMaceLoyaltyEnvReady() {
    const hasForm = !!document.querySelector('.t706 form');
    const hasDeliveryGroup = !!document.querySelector('.t-input-group_dl');
    const hasPromoWrapper = !!document.querySelector('.t-inputpromocode__wrapper');
    const hasPhoneInput = !!document.querySelector('input[name="Phone"]');
    const hasTcart = typeof window.tcart === 'object' && window.tcart !== null;
    const hasRedrawTotal = typeof window.tcart__reDrawTotal === 'function';

    return (
      hasForm &&
      hasDeliveryGroup &&
      hasPromoWrapper &&
      hasPhoneInput &&
      hasTcart &&
      hasRedrawTotal
    );
  }

  function bootstrapMaceLoyalty(attempt) {
    attempt = attempt || 0;

    if (!validateSettings()) {
      return;
    }

    if (isMaceLoyaltyEnvReady()) {
      logInfo('Окружение готово, запускаем initMaceLoyalty');
      initMaceLoyalty();
      return;
    }

    if (attempt > 120) {
      logError('Окружение так и не подготовилось после 60 секунд, прекращаем попытки.');
      return;
    }

    logInfo('Окружение ещё не готово, пробуем снова через 500ms (попытка ' + attempt + ')');
    setTimeout(function () {
      bootstrapMaceLoyalty(attempt + 1);
    }, 500);
  }

  function getSelectedPaymentSystem() {
    const checked = document.querySelector('input[name="paymentsystem"]:checked');
    return checked ? checked.value : null;
  }

  function isPaymentForbidden() {
    const current = getSelectedPaymentSystem();
    const forbidden = Array.isArray(MaceLoyaltySettings.forbiddenPayment)
      ? MaceLoyaltySettings.forbiddenPayment
      : [];

    if (!current) return false;
    return forbidden.indexOf(current) !== -1;
  }

  function getDesignClass() {
    const variant = MaceLoyaltySettings.designVariant || DesignVariant.BLUE;
    switch (variant) {
      case DesignVariant.GREY:
        return 'maceloyalty--grey';
      case DesignVariant.WHITE:
        return 'maceloyalty--white';
      case DesignVariant.BLUE:
      default:
        return 'maceloyalty--blue';
    }
  }

  function detectTildaFont() {
    const el = document.querySelector('.t-name');
    if (!el) return 'sans-serif';

    const style = window.getComputedStyle(el);
    const font = style.fontFamily || '';

    if (!font || font.trim() === '') return 'sans-serif';
    return font;
  }

  function getBonusWord(n) {
    const abs = Math.abs(n);
    const lastTwo = abs % 100;
    const last = abs % 10;

    if (lastTwo >= 11 && lastTwo <= 14) return 'бонусов';
    if (last === 1) return 'бонус';
    if (last >= 2 && last <= 4) return 'бонуса';
    return 'бонусов';
  }

  function formatBonuses(n) {
    const number = Number.isFinite(n) ? n : 0;
    const formatted = number.toLocaleString('ru-RU');
    return `${formatted} ${getBonusWord(number)}`;
  }

  // считает общее кол-во бонусов, сколько начислить и сколько можно списать
  function calculateCashbackMetrics(card) {
    const cartValue = window.tcart.prodamount;

    const totalCashback =
      card.balance && typeof card.balance.totalCashback === 'number'
        ? card.balance.totalCashback
        : 0;

    const modifier =
      card.level && typeof card.level.modifier === 'number'
        ? card.level.modifier
        : 0;

    const maxUsePercent =
      card.balance && typeof card.balance.maxUsePercent === 'number'
        ? card.balance.maxUsePercent
        : 0;

    const bonusesToDeposit = Math.floor(modifier * cartValue / 100);
    const bonusesToWithdrawal = Math.min(maxUsePercent * cartValue / 100, totalCashback);

    return {
      totalCashback,
      bonusesToDeposit,
      bonusesToWithdrawal,
    };
  }

  // Меняем подписи в итоговом блоке корзины
  function updateCartTotalsLabels() {
    const totalInfo = document.querySelector('.t706__cartwin-totalamount-info');
    if (!totalInfo) return;

    // есть ли наш промокод
    const hasPersonalPromo =
      !!(window.tcart &&
        window.tcart.promocode &&
        window.tcart.promocode.promocode === 'PERSONALCODE');

    if (!hasPersonalPromo) return;

    const cardType = (
      MaceLoyaltyState.card &&
      MaceLoyaltyState.card.balance &&
      (MaceLoyaltyState.card.balance.type || '')
    ).toLowerCase();

    if (!cardType) return;

    const labels = totalInfo.querySelectorAll('.t706__cartwin-totalamount-info_label');

    labels.forEach(label => {
      const text = (label.textContent || '').trim();

      if (cardType === 'cashback') {
        // карта бонусная
        if (text === 'Скидка:') {
          label.textContent = 'Скидка бонусами:';
        }
      } else if (cardType === 'discount') {
        // карта с процентной скидкой
        if (text === 'Промокод:') {
          label.textContent = 'Скидка по карте лояльности:';
        } else if (text === 'Скидка:') {
          label.textContent = 'Сумма скидки:';
        }
      }
    });
  }

  function ensureHiddenFields() {
    const form = document.querySelector('.t706 form');
    if (!form) {
      logError('Форма корзины ".t706 form" не найдена, скрытые поля не будут созданы.');
      return null;
    }

    function ensureInput(name) {
      let input = form.querySelector('input[name="' + name + '"]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        form.insertBefore(input, form.firstChild);
      }
      return input;
    }

    HiddenFields.cardInstanceId = ensureInput('maceloyalty_cardInstanceId');
    HiddenFields.amount = ensureInput('maceloyalty_amount');
    HiddenFields.type = ensureInput('maceloyalty_type');
    HiddenFields.companyId = ensureInput('maceloyalty_companyId');
    HiddenFields.useBonusAmount = ensureInput('maceloyalty_useBonusAmount');

    return HiddenFields;
  }

  function updateHiddenFields() {

    if (!MaceLoyaltyState.card) {
      clearHiddenFields();
      return;
    }

    const fields = HiddenFields.cardInstanceId ? HiddenFields : ensureHiddenFields();
    if (!fields) return;

    const cardInstanceId =
      MaceLoyaltyState.card && MaceLoyaltyState.card.cardInstanceId
        ? MaceLoyaltyState.card.cardInstanceId
        : '';

    let amount = '';

    if (window.tcart) {
      // если применён наш промокод (useCashback или addPurchase),
      // то берём итоговую сумму с учётом скидки/списания
      if (
        (MaceLoyaltyState.mode === 'useCashback' ||
          MaceLoyaltyState.mode === 'addPurchase') &&
        typeof window.tcart.prodamount_withdiscount === 'number'
      ) {
        amount = window.tcart.prodamount_withdiscount;
      } else if (typeof window.tcart.prodamount === 'number') {
        // во всех остальных случаях — базовая сумма товаров
        amount = window.tcart.prodamount;
      }
    }

    const useBonusAmount =
      MaceLoyaltyState.mode === 'useCashback' &&
        typeof MaceLoyaltyState.useBonusAmount === 'number'
        ? MaceLoyaltyState.useBonusAmount
        : '';

    fields.cardInstanceId.value = cardInstanceId;
    fields.amount.value = amount;
    fields.type.value = MaceLoyaltyState.mode || '';
    fields.companyId.value = MaceLoyaltySettings.clientId || '';
    fields.useBonusAmount.value = useBonusAmount === '' ? '' : String(useBonusAmount);
  }

  function clearHiddenFields() {
    const fields = HiddenFields.cardInstanceId ? HiddenFields : ensureHiddenFields();
    if (!fields) return;

    // очищаем значения hidden-полей
    fields.cardInstanceId.value = '';
    fields.amount.value = '';
    fields.type.value = '';
    fields.companyId.value = '';
    if (fields.useBonusAmount) {
      fields.useBonusAmount.value = '';
    }

    // сбрасываем состояние карты лояльности
    MaceLoyaltyState.card = null;
    MaceLoyaltyState.phone = null;
    MaceLoyaltyState.mode = null;
    MaceLoyaltyState.bonusesToDeposit = 0;
    MaceLoyaltyState.bonusesToWithdrawal = 0;
    MaceLoyaltyState.totalCashback = 0;
    MaceLoyaltyState.useBonusAmount = 0;
  }

  // удаляем промокоды из корзины
  function removePromo() {
    const cartID = document.querySelector('div[data-record-type="706"]')?.getAttribute('id').replace(/[^0-9]/g, '');
    const promoID = document.querySelector('.t-input-group_pc')?.getAttribute('data-input-lid');

    if (window.tcart.promocode) {
      delete window.tcart.promocode;
    }

    if (window.tcart.prodamount_discountsum) {
      delete window.tcart.prodamount_discountsum;
    }

    if (window.tcart.prodamount_withdiscount) {
      delete window.tcart.prodamount_withdiscount;
    }

    if (window.tcart.delivery && window.tcart.delivery.price) {
      window.tcart.amount = window.tcart.prodamount + window.tcart.delivery.price;
    } else {
      window.tcart.amount = window.tcart.prodamount;
    }

    document.querySelector('.t-inputpromocode__wrapper').innerHTML = promoField;

    let promoBlock = document.querySelector('.t-input-group_pc');
    if (promoBlock) {
      promoBlock.style.display = 'block';
    }

    window.tcart__saveLocalObj();
    window.tcart__reDrawProducts();
    window.tcart__updateTotalProductsinCartObj();
    window.tcart__reDrawCartIcon();
    window.tcart__reDrawTotal();
    window.t_input_promocode_init(cartID, promoID);
  }

  // применение промокода (списывание бонусов)
  function applyUseCashbak(cardType, amountToSpend) {
    // проводим проверки перед списыванием
    if (amountToSpend == 0) {
      logError(
        'Попытка списать 0 рублей.'
      );
      return;
    } else if (!amountToSpend || !cardType) {
      logError(
        'Не передано значение для списывания или тип карты.'
      );
      return;
    }

    // проверяем нет ли промокода в корзине
    if (window.tcart && window.tcart.promocode) {
      if (window.tcart.promocode.promocode && window.tcart.promocode.promocode == "PERSONALCODE") {
        logInfo('Бонусы уже списаны, дополнительные действия не требуются.');
        return;
      }

      // удаляем любые промокоды из корзины
      removePromo();
    }

    let bonuspromo;

    if (cardType == 'cashback') {
      bonuspromo = {
        "promocode": "PERSONALCODE",
        "discountsum": String(amountToSpend),
        "prodamount_discountsum": String(amountToSpend)
      }
      logInfo('Рассчитаны бонусы для карты типа "кэшбек"');
    } else if (cardType == 'discount') {
      bonuspromo = {
        "promocode": "PERSONALCODE",
        "discountpercent": String(amountToSpend)
      }
      logInfo('Рассчитаны бонусы для карты типа "дискаунт"');
    } else {
      logError('Не найден типа карты ' + cardType);
      return;
    }

    window.t_input_promocode__addPromocode(bonuspromo);

    let promoBlock = document.querySelector('.t-input-group_pc');
    if (promoBlock) {
      promoBlock.style.display = 'none';
    }

    logInfo('Списаны бонусы: ' + amountToSpend);
  }

  // Вставляем простые базовые стили (дефолтный светло-серый + разные темы)
  function injectBaseStylesOnce() {
    if (document.getElementById('maceloyalty-base-styles')) return;

    const style = document.createElement('style');
    style.id = 'maceloyalty-base-styles';
    style.textContent = `
      /* цветовые темы (акцентные цвета для кнопок и текста) */
      .maceloyalty--blue {
        --ml-accent-bg: #2D68F8;
        --ml-accent-border: none;
        --ml-accent-text: #ffffff;
        --ml-button-border: #ffffff;
        --ml-button-active-text-color: #000000;
        --ml-button-inactive-text-color: #ffffff;
        --ml-loader-color: rgba(255,255,255,0.15);
        --ml-loader-top-color: rgba(255,255,255,0.45);
        background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20345%20165'%3E%3Cdefs%3E%3ClinearGradient%20id='mlg'%20x1='0'%20y1='1'%20x2='1'%20y2='0'%3E%3Cstop%20stop-color='%23F5F7F8'/%3E%3Cstop%20offset='1'%20stop-color='%23DCE1E4'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg%20opacity='.4'%3E%3Crect%20opacity='.3'%20x='209.231'%20y='298.462'%20width='295.897'%20height='295.897'%20rx='5'%20transform='rotate(-135%20209.231%20298.462)'%20fill='url(%23mlg)'/%3E%3Crect%20opacity='.3'%20x='282.096'%20y='298.462'%20width='295.897'%20height='295.897'%20rx='5'%20transform='rotate(-135%20282.096%20298.462)'%20fill='url(%23mlg)'/%3E%3Crect%20opacity='.4'%20x='359.371'%20y='298.462'%20width='295.897'%20height='295.897'%20rx='5'%20transform='rotate(-135%20359.371%20298.462)'%20fill='url(%23mlg)'/%3E%3Crect%20opacity='.6'%20x='431.231'%20y='298.462'%20width='295.897'%20height='295.897'%20rx='5'%20transform='rotate(-135%20431.231%20298.462)'%20fill='url(%23mlg)'/%3E%3C/g%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: calc(100% + 1px);
        background-size: cover;
      }
      .maceloyalty--grey {
        --ml-accent-bg: #F5F5F6;
        --ml-accent-border: none;
        --ml-accent-text: #000000;
        --ml-button-border: #000000;
        --ml-button-active-text-color: #ffffff;
        --ml-button-inactive-text-color: #000000;
        --ml-loader-color: rgba(0,0,0,0.15);
        --ml-loader-top-color: rgba(0,0,0,0.45);
        background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20130%20131'%3E%3Cpath%20d='M100.159%2026.8376%20103.13%2050.449%20125.168%2059.4296%20110.573%2078.226%20119.806%20100.159%2096.1946%20103.13%2087.214%20125.168%2068.4176%20110.573%2046.4841%20119.806%2043.5134%2096.1946%2021.4755%2087.214%2036.0705%2068.4176%2026.8376%2046.4841%2050.449%2043.5134%2059.4296%2021.4755%2078.226%2036.0705%20100.159%2026.8376Z'%20fill='%23EBEBEB'/%3E%3Cg%20fill='none'%20stroke='%23F5F5F6'%20stroke-width='4'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M58%2088%2088%2058'/%3E%3Cpath%20d='M62%2066c2.21%200%204-1.79%204-4s-1.79-4-4-4-4%201.79-4%204%201.79%204%204%204Z'/%3E%3Cpath%20d='M86%2090c2.21%200%204-1.79%204-4s-1.79-4-4-4-4%201.79-4%204%201.79%204%204%204Z'/%3E%3C/g%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: calc(100% - 6px) calc(100% - 6px);
      }
      .maceloyalty--white {
        --ml-accent-bg: #ffffff;
        --ml-accent-border: #DFE4EA;
        --ml-accent-text: #000000;
        --ml-button-border: #000000;
        --ml-loader-color: rgba(0,0,0,0.15);
        --ml-loader-top-color: rgba(0,0,0,0.45);
        --ml-button-active-text-color: #ffffff;
        --ml-button-inactive-text-color: #000000;
      }

      #maceloyalty {
        box-sizing: border-box;
        width: 100%;
        padding: 37px 30px;
        border-radius: 16px;
        min-height: 120px;
        font-family: ${detectedFontFamily};
      }

      .maceloyalty {
        position: relative;
        background-color: var(--ml-accent-bg, #2D68F8);
        border: 1px solid var(--ml-accent-border, none);
      }

      /* лоадер */
      .maceloyalty__loader {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .maceloyalty__loader-spinner {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 2px solid var(--ml-loader-color, rgba(255,255,255,0.15));
        border-top-color: var(--ml-loader-top-color, rgba(255,255,255,0.45));
        animation: maceloyalty-spin 0.8s linear infinite;
      }

      /* типографика */
      .maceloyalty__header {
        display: flex;
        column-gap: 4px;
        align-items: center;
        font-size: 20px;
        font-weight: 400;
        color: var(--ml-accent-text, #ffffff);
        margin-bottom: 24px;
      }

      .maceloyalty__header.maceloyalty__discount {
        font-size: 30px;
        line-height: 30px;
        font-weight: 600;
      }

      .maceloyalty__header b {
        font-size: 22px;
        font-weight: 700;
      }

      .maceloyalty__nouser__text {
        width: 70%;
      }

      .maceloyalty__nouser {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .maceloyalty__nouser .maceloyalty__header {
        font-size: 24px;
        font-weight: 700;
      }

      .maceloyalty__subheader {
        font-size: 18px;
        line-height: 18px;
        color: var(--ml-accent-text, #ffffff);
      }

      .maceloyalty__row {
        display: flex;
        justify-content: left;
        align-items: center;
        gap: 19px;
        flex-wrap: wrap;
      }

      /* кнопки */
      .maceloyalty__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 12px 16px;
        border: 1px solid var(--ml-button-border, #ffffff);
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        line-height: 20px;
        white-space: nowrap;
        background-color: var(--ml-button-border, #ffffff);
        color: var(--ml-button-active-text-color, #000000);
      }

      .maceloyalty__btn--secondary {
        background-color: transparent;
        color: var(--ml-button-inactive-text-color, #ffffff);
      }

      .maceloyalty__btn--disabled {
        opacity: 0.4;
        cursor: default;
        transition: opacity 0.3s ease-in-out;
      }

      .maceloyalty__btn--disabled:hover {
        opacity: 0.2;
      }

      /* блоки опций / подсказок для cashback */
      .maceloyalty__options {
        margin-top: 16px;
        font-size: 14px;
      }
      .maceloyalty__option {
        margin-top: 8px;
      }
      .maceloyalty__option input {
        margin-right: 6px;
      }

      @media screen and (max-width: 480px) {
        #maceloyalty {
          padding: 24px 18px;        
        }

        .maceloyalty__btn {
          padding: 6px 8px;  
          flex: 1;      
        }

        .maceloyalty__header {
          margin-bottom: 16px;
          font-weight: 600;

          span {
            font-size: 16px;
            
            b {
              font-size: 18px;
            }
          } 
        }

      .maceloyalty__nouser {
        flex-wrap: wrap;

        .maceloyalty__nouser__text {
          width: 100%;
          margin-bottom: 16px;
        }

        .maceloyalty__header {
          font-size: 18px;
          magin-bottom: 12px;
        }

        .maceloyalty__subheader {
          font-size: 16px;
        }
      }

        .maceloyalty__header.maceloyalty__discount {
          font-size: 25px;
          line-height: 25px;
        }
      }

      @keyframes maceloyalty-spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  function findPhoneInput() {
    // Ищем скрытый input с name="cartPhone" — это «правильная» дата
    const hiddenPhone = document.querySelector('input[name="Phone"]');
    if (!hiddenPhone) {
      logError(
        'Не найдено поле "Phone" в корзине. Интеграция не запущена.'
      );
      return null;
    }

    // Находим группу и видимый input с маской телефона
    const group = hiddenPhone.closest('.t-input-group');
    if (!group) {
      logError(
        'Не найден блок .t-input-group для "Phone". Интеграция не запущена.'
      );
      return null;
    }

    const visibleInput =
      group.querySelector('input.t-input-phonemask') ||
      group.querySelector('input[type="tel"]');

    if (!visibleInput) {
      logError(
        'Не найден блок .t-input-phonemask. Интеграция не запущена.'
      );
      return null;
    }

    return visibleInput;
  }

  function ensureMaceloyaltyContainer() {
    let container = document.getElementById('maceloyalty');
    if (container) return container;

    const deliveryGroup = document.querySelector('.t-input-group_dl');
    if (!deliveryGroup || !deliveryGroup.parentNode) {
      logError(
        'Блок доставки ".t-input-group_dl" не найден. Невозможно запустить интеграцию.'
      );
      return null;
    }

    container = document.createElement('div');
    container.id = 'maceloyalty';
    container.className = 'maceloyalty ' + getDesignClass();

    // вставляем ПЕРЕД блоком доставки
    deliveryGroup.parentNode.insertBefore(container, deliveryGroup);

    return container;
  }

  function showLoader() {
    const container = ensureMaceloyaltyContainer();
    if (!container) return;

    container.innerHTML = `
      <div class="maceloyalty__loader">
        <div class="maceloyalty__loader-spinner"></div>
      </div>
    `;
  }

  // =========================
  // ВЫЗОВ API ПО ТЕЛЕФОНУ (пока просто логируем ответ)
  // =========================
  function renderNoCardState(phoneDigits) {
    const container = ensureMaceloyaltyContainer();
    clearHiddenFields();
    if (!container) return;

    container.innerHTML = `
      <div class="maceloyalty__nouser">
      <div class="maceloyalty__nouser__text">
        <div class="maceloyalty__header">Станьте участником нашей бонусной программы</div>
        <div class="maceloyalty__subheader">Скидки • Предложения • Бонусы</div>
      </div>
        <button type="button"
          class="maceloyalty__btn"
          data-ml-action="issue"
        >
          Оформить карту
        </button>
      </div>
    `;

    const btn = container.querySelector('[data-ml-action]');
    if (!btn) return;

    btn.addEventListener('click', function () {
      const mode = btn.getAttribute('data-ml-action');

      if (mode === 'issue') {
        // открыть страницу оформления карты
        window.open(MaceLoyaltySettings.cardIssueURL, '_blank');

        // поменять кнопку на "Обновить"
        btn.textContent = 'Обновить';
        btn.setAttribute('data-ml-action', 'refresh');
      } else if (mode === 'refresh') {
        // повторный запрос карты по тому же номеру
        showLoader();
        fetchCardByPhone(phoneDigits);
      }
    });
  }

  function renderCashbackCard(card, phoneDigits) {
    const container = ensureMaceloyaltyContainer();
    if (!container) return;

    const { totalCashback, bonusesToDeposit, bonusesToWithdrawal } =
      calculateCashbackMetrics(card);

    const spendFloor = Math.floor(bonusesToWithdrawal);
    const canUse = spendFloor > 0;

    MaceLoyaltyState.card = card;
    MaceLoyaltyState.phone = phoneDigits;
    MaceLoyaltyState.mode = 'addCashback';
    MaceLoyaltyState.bonusesToDeposit = bonusesToDeposit;
    MaceLoyaltyState.bonusesToWithdrawal = bonusesToWithdrawal;
    MaceLoyaltyState.totalCashback = totalCashback;
    MaceLoyaltyState.useBonusAmount = 0;

    updateHiddenFields();

    container.innerHTML = `
      <div class="maceloyalty__header">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><g clip-path="url(#clip0_0_57)"><path d="M13.7143 0.857178V9.42861H19.7143L10.2857 23.1429V14.5715H4.28572L13.7143 0.857178Z" stroke="#FFB003" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g><defs><clipPath id="clip0_0_57"><rect width="24" height="24" fill="white"/></clipPath></defs></svg> <span>На вашей карте лояльности <b>${formatBonuses(totalCashback)}</b></span>
      </div>

      <div class="maceloyalty__row">
        <button type="button"
          class="maceloyalty__btn"
          data-ml-mode="add"
        >
          Накопить ${formatBonuses(bonusesToDeposit)}
        </button>

        <button type="button"
          class="maceloyalty__btn maceloyalty__btn--secondary"
          data-ml-mode="use"
        >
          Списать ${formatBonuses(Math.floor(spendFloor))}
        </button>
      </div>
    `;

    const btnAdd = container.querySelector('[data-ml-mode="add"]');
    const btnUse = container.querySelector('[data-ml-mode="use"]');

    if (!btnAdd || !btnUse) return;

    if (!canUse) {
      btnUse.classList.add('maceloyalty__btn--disabled');
      btnUse.setAttribute('aria-disabled', 'true');
      btnUse.setAttribute('tabindex', '-1');
    }

    function setActive(mode) {
      if (mode === 'add') {
        // выбран "Накопить"
        btnAdd.classList.remove('maceloyalty__btn--secondary');
        btnUse.classList.add('maceloyalty__btn--secondary');
        MaceLoyaltyState.mode = 'addCashback';
        MaceLoyaltyState.useBonusAmount = 0;
        removePromo();
        updateHiddenFields();
      } else if (mode === 'use') {
        if (!canUse) return; // нельзя списывать, просто игнорируем
        // выбран "Списать"
        btnUse.classList.remove('maceloyalty__btn--secondary');
        btnAdd.classList.add('maceloyalty__btn--secondary');
        MaceLoyaltyState.mode = 'useCashback';
        MaceLoyaltyState.useBonusAmount = spendFloor;
        updateHiddenFields();
        applyUseCashbak(card.balance.type, spendFloor);
      }
    }

    // по умолчанию: "Накопить" активно (чёрная)
    setActive('add');

    btnAdd.addEventListener('click', function () {
      setActive('add');
    });

    btnUse.addEventListener('click', function () {
      setActive('use');
    });
  }

  function renderDiscountCard(card, phoneDigits) {
    const container = ensureMaceloyaltyContainer();
    if (!container) return;

    const modifier =
      card.level && typeof card.level.modifier === 'number'
        ? card.level.modifier
        : 0;
    const percent = Math.round(modifier);

    MaceLoyaltyState.card = card;
    MaceLoyaltyState.phone = phoneDigits;
    MaceLoyaltyState.mode = 'addPurchase';
    MaceLoyaltyState.bonusesToDeposit = 0;
    MaceLoyaltyState.bonusesToWithdrawal = 0;
    MaceLoyaltyState.useBonusAmount = 0;

    updateHiddenFields();

    container.innerHTML = `
      <div class="maceloyalty__header maceloyalty__discount"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><g clip-path="url(#clip0_0_57)"><path d="M13.7143 0.857178V9.42861H19.7143L10.2857 23.1429V14.5715H4.28572L13.7143 0.857178Z" stroke="#FFB003" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g><defs><clipPath id="clip0_0_57"><rect width="24" height="24" fill="white"/></clipPath></defs></svg> <span>Мы применили скидку ${percent}%</span></div>
      <div class="maceloyalty__subheader">
        по вашей карте лояльности
      </div>
    `;

    applyUseCashbak(card.balance.type, percent);
  }

  function renderCardState(card, phoneDigits) {
    const type = (card.balance.type || '').toLowerCase();

    if (type === 'cashback') {
      renderCashbackCard(card, phoneDigits);
    } else if (type === 'discount') {
      renderDiscountCard(card, phoneDigits);
    } else {
      // на всякий случай считаем неизвестный тип как cashback
      logInfo('Неизвестный тип карты, используем поведение cashback:', type);
      renderCashbackCard(card, phoneDigits);
    }
  }

  async function fetchCardByPhone(phoneDigits) {
    const { clientId, secret } = MaceLoyaltySettings;
    const url =
      API_HOST +
      '/cards?customer.phoneNumber.like=' +
      encodeURIComponent(phoneDigits) +
      '&pageSize=5';

    logInfo('Получаем карту по номеру телефона: ' + phoneDigits);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: 'Basic ' + btoa(clientId + ':' + secret),
        },
      });

      if (!response.ok) {
        const text = await response.text();
        logError(
          'Ошибка: ' + response.status + ' ' + response.statusText
        );
        console.log(text);
        return;
      }

      const data = await response.json();
      logInfo('Ответ сервера:');
      console.log(data);

      if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
        logInfo('Карта по этому номеру не найдена.');
        renderNoCardState(phoneDigits);
        return;
      }

      const card = data.items[0];
      logInfo('Используем первую найденную карту: ' + card.serialNumber);

      renderCardState(card, phoneDigits);

    } catch (e) {
      logError('Ошибка при получении карты: ' + e);
    }
  }

  // =========================
  // ОСНОВНАЯ ЛОГИКА: отслеживаем телефон
  // =========================
  function initMaceLoyalty() {
    if (!validateSettings()) {
      return; // без настроек не работаем, на верстке тишина
    }

    detectedFontFamily = detectTildaFont();
    promoField = document.querySelector('.t-inputpromocode__wrapper').innerHTML;
    injectBaseStylesOnce();
    ensureHiddenFields();
    clearHiddenFields();

    const phoneInput = findPhoneInput();
    if (!phoneInput) {
      return; // не нашли поле телефона — выходим тихо
    }

    logInfo('Интеграция запущена. Ожидание ввода номера телефона');

    let lastValidPhone = null;

    const onPhoneInput = function (event) {
      const rawValue = event.target.value || '';
      const digits = rawValue.replace(/\D/g, ''); // только цифры

      if (digits.length === 10) {
        // полный номер без кода страны, например 916 555 55 55
        const phoneForApi = digits;

        // Если выбран несовместимый способ оплаты – вообще не грузим карту
        if (isPaymentForbidden()) {
          logInfo('Выбран несовместимый способ оплаты, карту лояльности не загружаем.');
          // не запоминаем lastValidPhone, чтобы после смены способа оплаты
          // можно было подтянуть карту для уже введённого номера
          clearHiddenFields();
          removePromo();
          const container = document.getElementById('maceloyalty');
          if (container) container.remove();
          return;
        }

        // Проверяем, не тот же номер уже обрабатывали при совместимом способе оплаты
        if (phoneForApi === lastValidPhone) {
          return;
        }
        lastValidPhone = phoneForApi;

        // 1) показываем loader
        showLoader();

        // 2) вызываем API уже с номером БЕЗ кода страны
        fetchCardByPhone(phoneForApi);
      } else {
        // номер введен не полностью -> сбрасываем state и убираем блок
        if (lastValidPhone !== null) {
          logInfo('Номер телефона стал неполным. Сбрасываем статус.');
        }
        removePromo();
        clearHiddenFields();
        lastValidPhone = null;
        const container = document.getElementById('maceloyalty');
        if (container) container.remove();
      }
    };

    phoneInput.addEventListener('input', onPhoneInput);

    // следим за сменой способа оплаты
    const paymentInputs = document.querySelectorAll('input[name="paymentsystem"]');
    paymentInputs.forEach(function (input) {
      input.addEventListener('change', function () {
        const current = getSelectedPaymentSystem();
        logInfo('Сменился способ оплаты: ' + current);

        if (isPaymentForbidden()) {
          // Запрещённый способ оплаты — очищаем всё, скрываем блок
          logInfo('Выбран способ оплаты из forbiddenPayment, очищаем данные лояльности.');
          removePromo();
          clearHiddenFields();
          const container = document.getElementById('maceloyalty');
          if (container) container.remove();
          return;
        }

        // Способ оплаты совместим:
        // если телефон уже введён полностью — подгружаем карту автоматически
        const rawValue = phoneInput.value || '';
        const digits = rawValue.replace(/\D/g, '');

        if (digits.length === 10) {
          const phoneForApi = digits;

          logInfo('Совместимый способ оплаты и уже введён телефон, загружаем карту лояльности.');
          showLoader();
          lastValidPhone = phoneForApi;
          fetchCardByPhone(phoneForApi);
        } else {
          // телефон ещё не полный — просто очищаем UI лояльности
          removePromo();
          clearHiddenFields();
          const container = document.getElementById('maceloyalty');
          if (container) container.remove();
        }
      });
    });

    // следим за изменением общего итога
    var reDrawTotalFunction = window.tcart__reDrawTotal;
    window.tcart__reDrawTotal = function (d) {
      reDrawTotalFunction(d);
      setTimeout(function () {
        updateCartTotalsLabels();
        updateHiddenFields();
      }, 10);
    };
  }

  // =========================
  // СТАРТ
  // =========================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bootstrapMaceLoyalty();
    });
  } else {
    bootstrapMaceLoyalty();
  }
})();
