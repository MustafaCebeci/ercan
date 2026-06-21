<?php

interface Credentials
{

	public function getAsArray();

	public function getEndpoint();

	public function setEndpoint($endpoint);
}

class TopluMesaj
{
	private $tel = [];
	private $msg;

	/**
	 * @param $mesajMetni
	 * @param array|string $numaralar
	 */
	public function __construct($mesajMetni, $numaralar = '')
	{
		$this->msg = $mesajMetni;
		if (is_array($numaralar)) {
			$this->tel = $numaralar;
		} else {
			$this->tel = explode(',', $numaralar);
		}
	}

	public function getAsArray()
	{
		return [
			'tel' => $this->tel,
			'msg' => $this->msg
		];
	}

	public function numaraEkle($gsm)
	{
		$this->tel[] = $gsm;
	}
}

class MesajPaneliApi
{
	private $actions;
	private $parametricMessages = [];

	/**
	 *
	 * @param Credentials $credentials Kullanıcı login bilgileri
	 * @param bool $verifyssl SSL doğrulaması
	 * @throws Exception
	 */
	public function __construct(Credentials $credentials, $verifyssl = true)
	{
		$this->actions = new UserActions($credentials, $verifyssl);

	}

	##### Kullanıcı Bilgileri Fonksiyonları #####

	/**
	 * @return mixed
	 * @throws AuthenticationException
	 */
	public function baslikliKrediSorgula()
	{
		return $this->actions->getUser()->getOriginatedBalance();
	}

	/**
	 * User objesini döndürür.
	 *
	 * Beklenen array:
	 * $this->credentialsArray = [ 'name' => 'kullaniciAdi', 'pass' => 'sifre' ];
	 *
	 * Bilgiler doğru girildiğinde:
	 * {"userData":{"musteriid":"12345678","bayiid":"2415","musterikodu":"Demo","yetkiliadsoyad":"Demo","firma":"Demo","orjinli":"0","sistem_kredi":"0","basliklar":["850"]},"status":true}
	 *
	 * Bilgiler yanlış girildiğinde:
	 * {"status":false,"error":"Hatali kullanici adi, sifre girdiniz. Lutfen tekrar deneyiniz."}
	 *
	 * @return User
	 * @throws AuthenticationException
	 */
	public function getUser()
	{
		return $this->actions->getUser();
	}

	/**
	 * Telefon defterinden grup sil
	 *
	 * @param int $id
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function grubuSil($id)
	{
		return $this->actions->deleteAddressBook($id);
	}

	/**
	 * Grupta bir numara ara
	 *
	 * @param string $numara
	 * @param int $grupID
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function gruptaAra($numara, $grupID)
	{
		return $this->actions->searchNumberInGroup($numara, $grupID);
	}

	/**
	 * Gruba kayıtlı tüm kişiler
	 *
	 * @param int $grupID
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function gruptakiKisiler($grupID)
	{
		return $this->actions->getContactsByGroupID($grupID);
	}

	/**
	 * Hatalı kredi iade yapma metodu
	 *
	 * @param int $ref
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function hataliKrediIade($ref)
	{
		return $this->actions->refund($ref);
	}

	/**
	 * Kişi IDsi girerek kişi bilgilerini değiştir
	 *
	 * @param int $grupID
	 * @param int $kisiID
	 * @param array $degisiklikler
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function idIleKisiDuzenle($grupID, $kisiID, $degisiklikler)
	{
		return $this->actions->editContactById($grupID, $kisiID, $degisiklikler);
	}

	##### Mesaj Gönderim Fonksiyonları #####

	/**
	 * @return mixed
	 * @throws AuthenticationException
	 */
	public function kayitliBasliklar()
	{
		return $this->actions->getUser()->getSenders();
	}

	/**
	 * @return mixed
	 * @throws AuthenticationException
	 */
	public function musteriID()
	{
		return $this->actions->getUser()->getMid();
	}

	/**
	 * Gruptan kişi/numara çıkar
	 *
	 * @param int $grupID
	 * @param array $numaralar
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function numaraCikar($grupID, $numaralar)
	{
		return $this->actions->removeContact($grupID, $numaralar);
	}

	##### Rapor Alma Fonksiyonları #####

	/**
	 * Gruba kişi/numara ekle
	 *
	 * @param int $grupID
	 * @param array $numaralar
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function numaraEkle($grupID, $numaralar)
	{
		return $this->actions->addContact($grupID, $numaralar);
	}

	/**
	 * Telefon numarası girerek bir kişinin bilgilerini değiştir
	 *
	 * @param int $grupID
	 * @param int $numara
	 * @param array $degisiklikler
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function numaraIleKisiDuzenle($grupID, $numara, $degisiklikler)
	{
		return $this->actions->editContactByNumber($grupID, $numara, $degisiklikler);
	}

	##### Telefon Defteri Fonksiyonları #####

	/**
	 * @return mixed
	 * @throws AuthenticationException
	 */
	public function numerikKrediSorgula()
	{
		return $this->actions->getUser()->getNumericBalance();
	}

	/**
	 * Parametrik mesaj gönderimi için gsm ve mesaj ekleme metodu.
	 * Bu fonksiyon ile gsm ve mesajları tek tek ekliyorsanız,
	 * parametrikMesajGonder fonksiyonunda $data arrayini null giriniz.
	 *
	 * @param string $gsm
	 * @param string $mesaj
	 *
	 * @return void
	 */
	public function parametrikMesajEkle($gsm, $mesaj)
	{
		$this->parametricMessages[] = ['tel' => $gsm, 'msg' => $mesaj];
	}

	/**
	 * Parametrik mesaj gönderimi
	 *
	 * @param $baslik
	 * @param null|array $data
	 * @param bool $tr
	 * @param null|int $gonderimZamani
	 * @param bool $unique
	 *
	 * @return string
	 * @throws SmsException
	 * @throws AuthenticationException
	 */
	public function parametrikMesajGonder($baslik, $data = null, $tr = false, $gonderimZamani = null, $unique = true)
	{
		if (is_null($data)) {
			$data = $this->parametricMessages;
		}

		$response = $this->actions->parametricSMS($baslik, $data, $tr, $gonderimZamani, $unique);

		$this->parametricMessages = [];

		return $response;
	}

	/**
	 * Referans No ile rapor detayları
	 *
	 * @param $ref
	 * @param null|bool $tarihler
	 * @param null|bool $operatorler
	 *
	 * @return string
	 * @throws SmsException
	 * @throws AuthenticationException
	 */
	public function raporDetay($ref, $tarihler = null, $operatorler = null)
	{
		return $this->actions->reportDetails($ref, $tarihler, $operatorler);
	}

	/**
	 * Tüm raporlar
	 *
	 * @param null|array $tarihler
	 * @param null|int $limit
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function raporListele($tarihler = null, $limit = null)
	{
		return $this->actions->listReports($tarihler, $limit);
	}


	/**
	 * Tüm telefon defteri gruplarını getir
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function telefonDefteriGruplar()
	{
		return $this->actions->getAddressBooks();
	}

	/**
	 * Toplu mesaj gönderimi
	 *
	 * @param string $baslik
	 * @param TopluMesaj|array $data
	 * @param bool $tr
	 * @param null|int $gonderimZamani
	 *
	 * @return array
	 * @throws SmsException
	 * @throws AuthenticationException
	 */
	public function topluMesajGonder($baslik, $data, $tr = false, $gonderimZamani = null)
	{
		return $this->actions->bulkSMS($baslik, $data, $tr, $gonderimZamani);
	}

	/**
	 * Bir numarayı tüm gruplarda ara
	 *
	 * @param string $numara
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function tumGruplardaAra($numara)
	{
		return $this->actions->searchNumberInGroups($numara);
	}

	/**
	 * Telefon defterine yeni grup ekle
	 *
	 * @param string $title
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function yeniGrup($title)
	{
		return $this->actions->createAddressBook($title);
	}
}

class UserActions
{

	/**
	 * @var array
	 */
	private $requestData;

	/**
	 * @var string
	 */
	private $endpoint;

	/**
	 * @var bool
	 */
	private $verify_ssl;

	/**
	 * UserActions constructor.
	 *
	 * @param Credentials $credentials
	 * @param bool $verify_ssl
	 */
	public function __construct(Credentials $credentials, $verify_ssl = true)
	{
		$this->requestData['user'] = $credentials->getAsArray();
		$this->endpoint            = $credentials->getEndpoint();
		$this->verify_ssl         = $verify_ssl;
	}

	/**
	 * Add a contact/phone number to an address book group
	 *
	 * @param int $groupID
	 * @param array $rows
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function addContact($groupID, $rows)
	{
		if (!$groupID || !is_array($rows) || count($rows) < 1) {
			throw new AuthenticationException("Kişi eklemek istediğiniz grup IDsi ve kişi bilgileri arrayini dolu gönderdiğinize emin olun.");
		}

		$this->requestData['groupID'] = $groupID;
		$this->requestData['rows']    = $rows;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/addContact', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Send bulk SMS
	 *
	 * @param string $baslik
	 * @param TopluMesaj|array $data
	 * @param bool $tr
	 * @param null|int $gonderimZamani
	 *
	 * @return array
	 * @throws SmsException
	 * @throws AuthenticationException
	 */
	public function bulkSMS($baslik, $data, $tr = false, $gonderimZamani = null)
	{
		if (!$baslik) {
			$baslik = '850';
		}

		if (!strlen($baslik) >= 3) {
			throw new SmsException("Başlık minimum 3 karakterden oluşmalıdır.");
		}

		$this->requestData['msgBaslik'] = $baslik;

		if (!$data) {
			throw new SmsException("SMS gönderilecek numaralar ve gönderilmek istenen mesajı doğru gönderdiğinize emin olun. No Data");
		}

		if (is_object($data) && get_class($data) == TopluMesaj::class) {
			$data = $data->getAsArray();
		}

		if (!is_array($data) || !isset($data['tel']) || !isset($data['msg']) || !is_array($data['tel'])) {
			throw new SmsException("SMS gönderilecek numaralar ve gönderilmek istenen mesajı doğru gönderdiğinize emin olun. Data missing" . var_export($data, true));
		}

		$this->requestData['msgData'][] = $data;

		if ($gonderimZamani && $this->isValidTimeStamp($gonderimZamani)) {
			$this->requestData['start'] = $gonderimZamani;
		}

		if ($tr) {
			$this->requestData['tr'] = $tr;
		}

		$response = $this->doCurl($this->endpoint . '/api', $this->encode());

//        die($response);

		$base64Decoded = base64_decode($response);

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Add new group to address book
	 *
	 * @param string $title
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function createAddressBook($title)
	{
		if (!$title) {
			throw new AuthenticationException("Yeni grup ismi boş olamaz.");
		}

		if (in_array($title, $this->getUser()->getSenders())) {
			throw new AuthenticationException("Bu ($title) isimde bir grup zaten bulunmaktadır.");
		}

		$this->requestData['groupName'] = $title;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/createGroup', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Remove a group from address book
	 *
	 * @param int $id
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function deleteAddressBook($id)
	{
		if (!$id) {
			throw new AuthenticationException("Grup id boş olamaz.");
		}

		if (!$this->searchForId($id, $this->getAddressBooks())) {
			throw new AuthenticationException("Telefon defterinizde bu ($id) IDye sahip bir grup bulunmamaktadır.");
		}

		$this->requestData['groupID'] = $id;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/deleteGroup', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Edit contact details by id
	 *
	 * @param int $groupID
	 * @param int $contactID
	 * @param array $changes
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function editContactById($groupID, $contactID, $changes)
	{
		if (!$contactID || !$groupID || !is_array($changes) || count($changes) < 1) {
			throw new AuthenticationException("Grup IDsi, kişi IDsi ve değiştirmek istediğiniz kişi bilgilerini dolu gönderdiğinize emin olun.");
		}

		$this->requestData['groupID'] = $groupID;
		$this->requestData['search']  = $contactID;
		$this->requestData['changes'] = $changes;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/editContactById', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Edit contact details by phone number
	 *
	 * @param int $groupID
	 * @param string $number
	 * @param array $changes
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function editContactByNumber($groupID, $number, $changes)
	{
		if (!$number || !$groupID || !is_array($changes) || count($changes) < 1) {
			throw new AuthenticationException("Grup IDsi, kişiye ait telefon numarası ve değiştirmek istediğiniz kişi bilgilerini dolu gönderdiğinize emin olun.");
		}

		$this->requestData['groupID'] = $groupID;
		$this->requestData['search']  = $number;
		$this->requestData['changes'] = $changes;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/editContactByNumber', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Returns all address books of logged in user
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function getAddressBooks()
	{
		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/getGroups', $this->encode()));

		return $this->checkJSON($base64Decoded, 'groupList');
	}

	/**
	 * Get all contacts in a group
	 *
	 * @param int $groupID
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function getContactsByGroupID($groupID)
	{
		if (!$groupID) {
			throw new AuthenticationException("Grup id boş olamaz.");
		}

		$this->requestData['groupID'] = $groupID;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/getContactsByGroupID', $this->encode()));

		return $this->checkJSON($base64Decoded, 'NumberList');
	}

	/**
	 * Returns the user object
	 *
	 * Expected array:
	 * $this->credentialsArray = [ 'name' => 'kullaniciAdi', 'pass' => 'sifre' ];
	 *
	 * Successful response upon sending correct credentials:
	 * {"userData":{"musteriid":"12345678","bayiid":"2415","musterikodu":"Demo","yetkiliadsoyad":"Demo","firma":"Demo","orjinli":"0","sistem_kredi":"0","basliklar":["850"]},"status":true}
	 *
	 * Failed response upon wrong credentials:
	 * {"status":false,"error":"Hatali kullanici adi, sifre girdiniz. Lutfen tekrar deneyiniz."}
	 *
	 * @return User
	 * @throws AuthenticationException
	 */
	public function getUser()
	{
		$userInfo = json_decode(base64_decode($this->doCurl($this->endpoint . '/login', $this->encode())), true);

		if (!$userInfo['status']) {
			$message = ($userInfo['error'] !== '') ? $userInfo['error'] : 'Hatalı cevap alındı. Kullanıcı bilgilerini kontrol edin.';
			throw new AuthenticationException($message);
		}

		return new User($userInfo);
	}

	/**
	 * All reports
	 *
	 * @param null|array $tarihler
	 * @param null|int $limit
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function listReports($tarihler = null, $limit = null)
	{
		if ($tarihler) {
			$this->requestData['tarih'] = $tarihler;
		}

		if ($limit) {
			$this->requestData['limit'] = $limit;
		}

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/report', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Send Parametric SMS
	 *
	 * @param $baslik
	 * @param null|array $data
	 * @param bool $tr
	 * @param null|int $gonderimZamani
	 * @param bool $unique
	 *
	 * @return string
	 * @throws SmsException
	 * @throws AuthenticationException
	 */
	public function parametricSMS($baslik, $data = null, $tr = false, $gonderimZamani = null, $unique = true)
	{
		if (!$baslik) {
			$baslik = '850';
		}

		if (!strlen($baslik) >= 3) {
			throw new SmsException("Başlık minimum 3 karakterden oluşmalıdır.");
		}

		$this->requestData['msgBaslik'] = $baslik;

		if (!$data || !is_array($data) || !count($data)) {
			throw new SmsException("SMS gönderilecek numaralar ve gönderilmek istenen mesajı doğru gönderdiğinize emin olun.");
		}

		$this->requestData['msgData'] = $data;

		if ($gonderimZamani && $this->isValidTimeStamp($gonderimZamani)) {
			$this->requestData['start'] = $gonderimZamani;
		}

		if ($unique) {
			$this->requestData['unique'] = $unique;
		}

		if ($tr) {
			$this->requestData['tr'] = $tr;
		}

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/api', $this->encode()));

		$this->requestData['msgData'] = [];

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Refund credits
	 *
	 * @param int $ref
	 *
	 * @return string
	 * @throws AuthenticationException Refund requires reference number
	 */
	public function refund($ref)
	{
		if (!$ref) {
			throw new AuthenticationException("Iade işlemi için referans no gereklidir.");
		}

		$this->requestData['refno'] = $ref;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/refund', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Remove a contact from an address book group
	 *
	 * @param int $groupID
	 * @param array $rows
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function removeContact($groupID, $rows)
	{
		if (!$groupID || !is_array($rows) || count($rows) < 1 || !isset($rows['numara'])) {
			throw new AuthenticationException("Numara çıkarmak istediğiniz grup IDsi ve numara arrayini dolu gönderdiğinize emin olun.");
		}

		$this->requestData['groupID'] = $groupID;
		$this->requestData['numara']  = $rows['numara'];

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/removeContact', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Report details by reference id
	 *
	 * @param $ref
	 * @param null|bool $dates
	 * @param null|bool $operators
	 *
	 * @return string
	 * @throws SmsException
	 * @throws AuthenticationException
	 */
	public function reportDetails($ref, $dates = null, $operators = null)
	{
		if (!$ref) {
			throw new SmsException("Referans numarası gereklidir.");
		}

		if ($dates) {
			$this->requestData['dates'] = $dates;
		}

		if ($operators) {
			$this->requestData['operators'] = $operators;
		}

		$this->requestData['refno'] = $ref;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/report', $this->encode()));

		return $this->checkJSON($base64Decoded);
	}

	/**
	 * Search a phone number in an address book group
	 *
	 * @param string $number
	 * @param int $groupID
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function searchNumberInGroup($number, $groupID)
	{
		if (!$number || !$groupID) {
			throw new AuthenticationException("Aranacak numara ve grup ID boş olamaz.");
		}

		$this->requestData['numara']  = $number;
		$this->requestData['groupID'] = $groupID;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/searchNumberInGroup', $this->encode()));

		return $this->checkJSON($base64Decoded, 'NumberInfo');
	}

	/**
	 * Search a phone number in all address book groups
	 *
	 * @param string $number
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	public function searchNumberInGroups($number)
	{
		if (!$number) {
			throw new AuthenticationException("Aranacak numara boş olamaz.");
		}

		$this->requestData['numara'] = $number;

		$base64Decoded = base64_decode($this->doCurl($this->endpoint . '/group/searchNumberInGroups', $this->encode()));

		return $this->checkJSON($base64Decoded, 'NumberInfo');
	}

	/**
	 * Decode and check the JSON response
	 *
	 * @param string $base64Decoded
	 * @param null|string $column
	 *
	 * @return array|string
	 * @throws AuthenticationException
	 */
	private function checkJSON($base64Decoded, $column = null)
	{
		$decoded = json_decode($base64Decoded, true);

		if (json_last_error() || $decoded['status'] === false) {
			throw new AuthenticationException(($decoded['error']) ? "Error: " . $decoded['error'] : 'Girilen bilgileri kontrol ediniz');
		}

		if ($column) {
			$decoded = $decoded[$column];
		}

		return (json_last_error()) ? "" : $decoded;
	}

	/**
	 * Curl request
	 *
	 * @param $endpoint
	 * @param $postFields
	 *
	 * @return string
	 */
	private function doCurl($endpoint, $postFields)
	{
		Curl::fetch(
			$endpoint,
			[
				CURLOPT_USERAGENT      => "PHP_API",
				CURLOPT_RETURNTRANSFER => 1,
				CURLOPT_POST           => 1,
				CURLOPT_SSL_VERIFYHOST => $this->verify_ssl,
				CURLOPT_SSL_VERIFYPEER => $this->verify_ssl,
				CURLOPT_POSTFIELDS     => $postFields,
				CURLOPT_TIMEOUT        => 50,
				CURLOPT_ENCODING       => '',
				CURLOPT_HEADERFUNCTION => [Curl::class, 'head'],
				CURLOPT_WRITEFUNCTION  => [Curl::class, 'body']
			]
		);

		return Curl::$body;
	}

	/**
	 * Encodes credentialsArray as data to be sent over Curl
	 *
	 * @return string
	 * @throws AuthenticationException
	 */
	private function encode()
	{
		if (!$this->requestData) {
			throw new AuthenticationException("Giriş bilgilerinin config.json dosyasinda varlığını kontrol edin.");
		}

		return "data=" . base64_encode(json_encode($this->requestData));
	}

	/**
	 * Checks if given timestamp is valid
	 *
	 * @param $timestamp
	 *
	 * @return bool
	 */
	private function isValidTimeStamp(&$timestamp)
	{
		if (is_numeric($timestamp)) {
			// unixtime
			$datetime = DateTimeImmutable::createFromFormat('U', $timestamp);
		} else {
			// Y-m-d H:i:s
			$datetime = DateTimeImmutable::createFromFormat('Y-m-d H:i:s', $timestamp);
		}

		if ($datetime === false) {
			return false;
		}

		$timestamp = $datetime->format('U');

		return true;
	}

	/**
	 * Search for value in multidimensional array
	 *
	 * @param $id
	 * @param $array
	 *
	 * @return bool|null
	 */
	private function searchForId($id, $array)
	{
		foreach ($array as $key => $val) {
			if ($val['id'] == $id) {
				return true;
			}
		}
		return null;
	}
}

class User
{
	private $userInfo = [];

	/**
	 * User constructor.
	 *
	 * @param $userInfo
	 *
	 * @throws AuthenticationException
	 */
	public function __construct($userInfo)
	{
		if (!is_array($userInfo) || !isset($userInfo['userData'])) {
			throw new AuthenticationException("UserInfo array olmalıdır.");
		}

		$this->userInfo = $userInfo['userData'];
	}

	public function getBid()
	{
		return $this->userInfo['bayiiid'];
	}

	public function getCompany()
	{
		return $this->userInfo['firma'];
	}

	public function getMid()
	{
		return $this->userInfo['musteriid'];
	}

	public function getMik()
	{
		return $this->userInfo['musterikodu'];
	}

	public function getName()
	{
		return $this->userInfo['yetkiliadsoyad'];
	}

	public function getNumericBalance()
	{
		return $this->userInfo['sistem_kredi'];
	}

	public function getOriginatedBalance()
	{
		return $this->userInfo['orjinli'];
	}

	public function getSenders()
	{
		return $this->userInfo['basliklar']; # array
	}
}

class Curl
{

	static $handle;    // Handle
	static $body = ''; // Response body
	static $head = ''; // Response head
	static $info = [];

	static function body($ch, $data)
	{
		unset($ch);
		self::$body .= $data;
		return strlen($data);
	}

	static function fetch($url, $opts = [])
	{
		self::$head = self::$body = '';

		self::$info   = [];
		self::$handle = curl_init($url);
		curl_setopt_array(self::$handle, $opts);
		curl_exec(self::$handle);
		self::$info = curl_getinfo(self::$handle);
		curl_close(self::$handle);
	}

	static function head($ch, $data)
	{
		unset($ch);
		self::$head = $data;
		return strlen($data);
	}
}

class CredentialsUsernamePassword implements Credentials
{
	private $endpoint = "https://api.mesajpaneli.com/json_api";

	private $username;
	private $password;

	/**
	 * Mesajpaneli üzerindeki kullanıcı adı ve şifreniz
	 *
	 * @param $username
	 * @param $password
	 */
	public function __construct($username, $password)
	{
		$this->username = $username;
		$this->password = $password;
	}

	public function getAsArray()
	{
		return ['name' => $this->username, 'pass' => $this->password];
	}


	public function getEndpoint()
	{
		return $this->endpoint;
	}

	public function setEndpoint($endpoint)
	{
		$this->endpoint = $endpoint;
	}
}

class CredentialsHash implements Credentials
{
	private $endpoint = "https://api.mesajpaneli.com/json_api";

	private $hash;

	/**
	 * Api ayarları sayfasından alınan Api Anahtarı ile kullanıcı bilgisi oluşturma
	 *
	 * @param string $hash
	 */
	public function __construct($hash)
	{
		$this->hash = $hash;
	}

	public function getAsArray()
	{
		return ['hash' => $this->hash];
	}

	public function getEndpoint()
	{
		return $this->endpoint;
	}

	public function setEndpoint($endpoint)
	{
		$this->endpoint = $endpoint;
	}
}

class Credential
{
	public static function fromHash($string)
	{
		return new CredentialsHash($string);
	}

	public static function fromUserLogin($username, $password)
	{
		return new CredentialsUsernamePassword($username, $password);
	}
}

class AuthenticationException extends Exception
{
}

class ClientException extends Exception
{
}

class SmsException extends Exception
{
}