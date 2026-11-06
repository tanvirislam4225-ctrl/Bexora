<?php
/*
 * Plugin Name: Secure Pay BD 
 * Plugin URI: https://securepaybd.xyz
 * Description: This plugin allows your customers to pay with Bkash, Nagad, Rocket, and all BD gateways via Secure Pay BD.
 * Author: Secure Pay BD
 * Author URI: https://securepaybd.xyz
 * Version: 1.0.0
 * Requires at least: 5.2
 * Requires PHP: 7.2
 * License: GPL v2 or later
 * License URI: 
 * Text Domain: securepaybd
 */

/*
 * This action hook registers our PHP class as a WooCommerce payment gateway
 */
add_action('plugins_loaded', 'securepaybd_init_gateway_class');

function securepaybd_init_gateway_class()
{
    if (!class_exists('WC_Payment_Gateway')) return;

    class WC_securepaybd_Gateway extends WC_Payment_Gateway
    {
        public function __construct()
        {
            $this->id = 'securepaybd';
            $this->has_fields = false;
            $this->method_title = __('Secure Pay BD', 'securepaybd');
            $this->method_description = __('Pay With Secure Pay BD', 'securepaybd');

            $this->supports = array('products');

            $this->init_form_fields();
            $this->init_settings();

            $this->icon = $this->get_option('logo_url');
            $this->title = $this->get_option('title');
            $this->description = $this->get_option('description');
            $this->enabled = $this->get_option('enabled');

            add_action('woocommerce_update_options_payment_gateways_' . $this->id, array($this, 'process_admin_options'));
            add_action('woocommerce_api_' . strtolower(get_class($this)), array($this, 'handle_webhook'));
        }

        public function init_form_fields()
{
    $this->form_fields = array(
        'enabled' => array(
            'title'       => 'Enable/Disable',
            'label'       => 'Enable Secure Pay BD',
            'type'        => 'checkbox',
            'description' => '',
            'default'     => 'no'
        ),
        'title' => array(
            'title'       => 'Title',
            'type'        => 'text',
            'description' => 'This controls the title which the user sees during checkout.',
            'default'     => 'Secure Pay BD Gateway',
            'desc_tip'    => true,
        ),
        'apikeys' => array(
            'title'       => 'Enter API Key',
            'type'        => 'text',
            'description' => '',
            'default'     => '###################',
            'desc_tip'    => true,
        ),
        'currency_rate' => array(
            'title'       => 'Enter USD Rate',
            'type'        => 'number',
            'description' => '',
            'default'     => '110',
            'desc_tip'    => true,
        ),
        'is_digital' => array(
            'title'       => 'Enable/Disable Digital product',
            'label'       => 'Enable Digital product',
            'type'        => 'checkbox',
            'description' => '',
            'default'     => 'no'
        ),
        'payment_site' => array(
            'title'             => 'Payment Site URL',
            'type'              => 'text',
            'description'       => '',
            'default'           => 'https://pay.securepaybd.xyz/',
            'desc_tip'          => true,
            'custom_attributes' => array(
                'readonly' => 'readonly'
            ),
        ),
        'logo_url' => array(
            'title'       => 'Payment Gateway Logo URL',
            'type'        => 'text',
            'description' => 'Enter the logo URL displayed at checkout.',
            'default'     => 'https://securepaybd.xyz/public/uploads/admin/902ba3cda1883801594b6e1b452790cc53948fda/1788973551_b619922b35ea8074192d.png',
            'desc_tip'    => true,
        ),
    );
}


        public function process_payment($order_id)
        {
            global $woocommerce;
            $order = wc_get_order($order_id);
            $current_user = wp_get_current_user();

            $subtotal = WC()->cart->subtotal;
            $shipping_total = WC()->cart->get_shipping_total();
            $fees = WC()->cart->get_fee_total();
            $discount_excl_tax_total = WC()->cart->get_cart_discount_total();
            $discount_tax_total = WC()->cart->get_cart_discount_tax_total();
            $discount_total = $discount_excl_tax_total + $discount_tax_total;
            $total = $subtotal + $shipping_total + $fees - $discount_total;

            if ($order->get_currency() == 'USD') {
                $total = $total * $this->get_option('currency_rate');
            }

            if ($order->get_status() != 'completed') {
                $order->update_status('pending', __('Customer is being redirected to Secure Pay BD', 'securepaybd'));
            }

            $data = array(
                "cus_name"    => $current_user->user_firstname,
                "cus_email"   => $current_user->user_email,
                "amount"      => $total,
                "webhook_url" => site_url('/?wc-api=wc_securepaybd_gateway&order_id=' . $order->get_id()),
                "success_url" => $this->get_return_url($order),
                "cancel_url"  => wc_get_checkout_url()
            );

            $header = array(
                "api" => $this->get_option('apikeys'),
                "url" => $this->get_option('payment_site') . "api/create"
            );

            $response = $this->create_payment($data, $header);

            $data = json_decode($response, true);

            return array(
                'result'   => 'success',
                'redirect' => $data['payment_url']
            );
        }

        public function create_payment($data = "", $header = '')
        {
            $headers = array(
                'Content-Type: application/json',
                'API-KEY: ' . $header['api'],
            );
            $url = $header['url'];
            $curl = curl_init();
            $data = json_encode($data);

            curl_setopt_array($curl, array(
                CURLOPT_URL => $url,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_ENCODING => '',
                CURLOPT_MAXREDIRS => 10,
                CURLOPT_TIMEOUT => 30,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
                CURLOPT_CUSTOMREQUEST => 'POST',
                CURLOPT_POSTFIELDS => $data,
                CURLOPT_HTTPHEADER => $headers,
            ));
            curl_setopt($curl, CURLOPT_SSL_VERIFYPEER, true);

            $response = curl_exec($curl);
            curl_close($curl);
            return $response;
        }

        /**
         * Pull the transaction id out of a callback.
         *
         * SecurePay BD posts the webhook as a JSON body. PHP does not populate
         * $_POST/$_REQUEST for JSON, so php://input has to be read explicitly.
         * Both spellings of the key are accepted, and query/form parameters are
         * still used as a fallback for the return-URL flow.
         */
        private function read_transaction_id()
        {
            $raw = file_get_contents('php://input');

            if (is_string($raw) && $raw !== '') {
                $decoded = json_decode($raw, true);

                if (is_array($decoded)) {
                    foreach (array('transactionId', 'transaction_id') as $key) {
                        if (!empty($decoded[$key])) {
                            return trim((string) $decoded[$key]);
                        }
                    }
                }
            }

            foreach (array('transactionId', 'transaction_id') as $key) {
                if (!empty($_REQUEST[$key])) {
                    return trim((string) $_REQUEST[$key]);
                }
            }

            return '';
        }

        private function log($message)
        {
            if (function_exists('wc_get_logger')) {
                wc_get_logger()->log('info', 'SecurePay BD: ' . $message);
            }
        }

        public function update_order_status($order)
        {
            $transactionId = $this->read_transaction_id();

            if ($transactionId === '') {
                // A malformed callback is not a failed payment. Leave the order
                // alone instead of quietly marking it on-hold, which hides the
                // real problem.
                $this->log('Callback without a transactionId for order #' . $order->get_id() . '. Order left unchanged.');

                return false;
            }

            $data = array(
                "transaction_id" => $transactionId,
            );
            $header = array(
                "api" => $this->get_option('apikeys'),
                "url" => $this->get_option('payment_site') . "api/verify"
            );

            $response = $this->create_payment($data, $header);
            $verified = json_decode($response, true);

            if (!is_array($verified) || empty($verified['status'])) {
                $this->log('Verification failed for order #' . $order->get_id() . ' (trx ' . $transactionId . '): ' . substr((string) $response, 0, 500));

                return false;
            }

            if ($order->get_status() === 'completed') {
                return true;
            }

            if (strtoupper((string) $verified['status']) !== 'COMPLETED') {
                $order->update_status('on-hold', __('Secure Pay BD payment is not completed. Transaction id: ' . $transactionId . '. Please check it manually.', 'securepaybd'));

                return true;
            }

            $amount = isset($verified['amount']) ? $verified['amount'] : '';
            $sender = isset($verified['cus_email']) ? $verified['cus_email'] : '';

            // Record the payment details before changing status.
            // payment_complete() only writes the transaction id and paid date
            // while the order is still pending/failed, so an order that the old
            // bug already left on-hold would end up marked as paid with no
            // transaction id and no paid date on it.
            if (method_exists($order, 'set_transaction_id')) {
                $order->set_transaction_id($transactionId);
            }

            if (method_exists($order, 'set_date_paid')) {
                $order->set_date_paid(time());
            }

            // payment_complete() reduces stock through the guarded
            // wc_maybe_reduce_stock_levels hook, so stock must not be reduced by
            // hand as well.
            $order->payment_complete($transactionId);

            $note = __("Secure Pay BD payment confirmed. Payment Method: securepaybd, Amount: {$amount}, Transaction ID: {$transactionId}, Sender: {$sender}", 'securepaybd');

            if ($this->get_option('is_digital') === 'yes') {
                $order->update_status('completed', $note);
            } else {
                $order->update_status('processing', $note);
            }

            // payment_complete() is a no-op for an order that is no longer
            // pending, which leaves stock untouched on a recovered order.
            // This call is guarded by WooCommerce's own "_order_stock_reduced"
            // flag, so it can never deduct the same stock twice.
            if (function_exists('wc_maybe_reduce_stock_levels')) {
                wc_maybe_reduce_stock_levels($order->get_id());
            }

            $order->add_order_note(__('Payment completed via SecurePay BD. trx id: ' . $transactionId, 'securepaybd'));
            $order->save();

            $this->log('Order #' . $order->get_id() . ' confirmed, trx ' . $transactionId . ', status ' . $order->get_status());

            return true;
        }

        public function handle_webhook()
        {
            $order_id = isset($_GET['order_id']) ? absint($_GET['order_id']) : 0;
            $order = $order_id ? wc_get_order($order_id) : false;

            if (!$order) {
                $this->log('Callback for unknown order #' . $order_id . '.');
            } else {
                $this->update_order_status($order);
            }

            status_header(200);
            echo json_encode(['message' => 'Webhook received and processed.']);
            exit();
        }
    }

    function securepaybd_add_gateway_class($gateways)
    {
        $gateways[] = 'WC_securepaybd_Gateway';
        return $gateways;
    }
    add_filter('woocommerce_payment_gateways', 'securepaybd_add_gateway_class');
}

/**
 * Alternate REST webhook path.
 *
 * Nothing currently posts here - the sender is configured with the wc-api URL
 * in process_payment() - but it is kept working so the endpoint cannot fatal.
 * It reuses the gateway's own verification, so it behaves identically to the
 * wc-api path and cannot double-complete an order.
 */
function securepaybd_handle_webhook()
{
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $gateways = WC()->payment_gateways->payment_gateways();
        $gateway = isset($gateways['securepaybd']) ? $gateways['securepaybd'] : null;

        if ($gateway) {
            $order_id = isset($_REQUEST['order_id']) ? absint($_REQUEST['order_id']) : 0;
            $order = $order_id ? wc_get_order($order_id) : false;

            if ($order) {
                $gateway->update_order_status($order);
            }
        }
    }

    status_header(200);
    echo json_encode(['message' => 'Webhook received and processed.']);
    exit();
}

add_action('rest_api_init', function () {
    register_rest_route('securepaybd/v1', '/webhook', array(
        'methods' => 'POST',
        'callback' => 'securepaybd_handle_webhook',
    ));
});
