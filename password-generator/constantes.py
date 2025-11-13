import string
longitud_minima = 10
longitud_maxima = 16
SIMBOLOS_PERMITIDOS = "!@#$%^&*_+-=:;\?./|"
SIMBOLOS_PERMITIDOS_ascii = [ord(caracter) for caracter in SIMBOLOS_PERMITIDOS]
ascii_inicio_Mayusculas = 65
ascii_fin_Mayusculas = 90
ascii_inicio_minuscula = 97
ascii_fin_minuscula = 122
ascii_inicio_numerico = 48
ascii_fin_numerico = 57
ALFABETO_EXTENDIDO = string.ascii_letters + string.digits + SIMBOLOS_PERMITIDOS
ascii = string.ascii_letters + string.digits + string.punctuation